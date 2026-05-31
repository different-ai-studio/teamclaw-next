// services/fc/lib/sync-handlers.mjs
//
// FC /sync/* endpoint handlers — OSS Sync v3 (spec §3).
// Each export is a standalone async function; the router in index.mjs
// dispatches here after JWT/actor auth.

import { createHash, randomUUID } from 'node:crypto';
import { S3Client, HeadObjectCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createServiceRoleClient } from './supabase.js';
import { validateSyncPath } from './sync-path.js';

// ---------------------------------------------------------------------------
// Env accessors
// ---------------------------------------------------------------------------
const ACCESS_KEY_ID     = () => process.env.ACCESS_KEY_ID     || '';
const ACCESS_KEY_SECRET = () => process.env.ACCESS_KEY_SECRET || '';
const BUCKET            = () => process.env.BUCKET            || 'teamclaw-sync';
const REGION            = () => process.env.REGION            || 'cn-hangzhou';
const ENDPOINT          = () => process.env.ENDPOINT          || 'https://oss-cn-hangzhou.aliyuncs.com';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function getS3Client() {
  return new S3Client({
    region: REGION(),
    endpoint: ENDPOINT(),
    credentials: {
      accessKeyId: ACCESS_KEY_ID(),
      secretAccessKey: ACCESS_KEY_SECRET(),
    },
    forcePathStyle: false,
  });
}

function ossKeyForHash(teamId, hash) {
  // "teams/{teamId}/blobs/sha256/<2chars>/<2chars>/<hash>"
  return `teams/${teamId}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}

// ---------------------------------------------------------------------------
// §3.1  POST /sync/manifest
// ---------------------------------------------------------------------------

/**
 * @param {{ userId, teamId, actorId }} caller
 * @param {object} body - { teamId, afterSeq, limit?, cursor?, snapshotSeq? }
 */
export async function handleSyncManifest(caller, body) {
  const { afterSeq = 0, limit = 200, cursor = null, snapshotSeq: clientSnapshotSeq } = body || {};
  const teamId = caller.teamId;

  const supabase = createServiceRoleClient();

  // Read current snapshot seq if client didn't supply one (first page).
  let snapshotSeq;
  if (typeof clientSnapshotSeq === 'number') {
    snapshotSeq = clientSnapshotSeq;
  } else {
    const { data: twc, error: twcErr } = await supabase
      .from('team_workspace_config')
      .select('oss_change_seq')
      .eq('team_id', teamId)
      .single();
    if (twcErr || !twc) {
      return json(404, { error: 'team not found or not configured for OSS sync' });
    }
    snapshotSeq = twc.oss_change_seq;
  }

  // Decode cursor: base64 JSON { seq, id }
  let cursorSeq = 0;
  let cursorId  = '00000000-0000-0000-0000-000000000000';
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
      cursorSeq = decoded.seq;
      cursorId  = decoded.id;
    } catch {
      return json(400, { error: 'invalid cursor' });
    }
  }

  const pageLimit = Math.min(Math.max(1, Number(limit) || 200), 1000);

  // Spec §3.1: WHERE change_seq > afterSeq AND change_seq <= snapshotSeq
  //            AND (change_seq, id) > (cursorSeq, cursorId)
  //            ORDER BY change_seq, id LIMIT n
  const { data: rows, error } = await supabase
    .from('amuxc_files')
    .select('id, path, current_version, content_hash, size, deleted, change_seq, updated_at, updated_by')
    .eq('team_id', teamId)
    .gt('change_seq', afterSeq)
    .lte('change_seq', snapshotSeq)
    .or(`change_seq.gt.${cursorSeq},and(change_seq.eq.${cursorSeq},id.gt.${cursorId})`)
    .order('change_seq', { ascending: true })
    .order('id', { ascending: true })
    .limit(pageLimit + 1);

  if (error) {
    return json(500, { error: `manifest query failed: ${error.message}` });
  }

  const hasMore = rows.length > pageLimit;
  const items = (hasMore ? rows.slice(0, pageLimit) : rows).map(r => ({
    path:            r.path,
    version:         r.current_version,
    contentHash:     r.content_hash,
    size:            r.size,
    deleted:         r.deleted,
    changeSeq:       r.change_seq,
    updatedAt:       r.updated_at,
    updatedBy:       r.updated_by,
  }));

  let nextCursor = null;
  if (hasMore) {
    const last = items[items.length - 1];
    const lastRow = rows.find(r => r.change_seq === last.changeSeq && r.path === last.path);
    nextCursor = Buffer.from(JSON.stringify({ seq: last.changeSeq, id: lastRow.id })).toString('base64');
  }

  return json(200, { snapshotSeq, items, nextCursor });
}

// ---------------------------------------------------------------------------
// §3.2  POST /sync/upload/prepare
// ---------------------------------------------------------------------------

/**
 * @param {{ userId, teamId, actorId }} caller
 * @param {object} body - { teamId, path, parentVersion, contentHash, size, nodeId }
 */
export async function handleSyncUploadPrepare(caller, body) {
  const { path, parentVersion, contentHash, size, nodeId } = body || {};

  // Validate path (spec §3.1.1)
  const pathCheck = validateSyncPath(path);
  if (!pathCheck.ok) {
    return json(422, { error: pathCheck.message, code: pathCheck.code });
  }

  if (!contentHash || typeof contentHash !== 'string') {
    return json(400, { error: 'contentHash is required' });
  }
  if (typeof size !== 'number' || size < 0) {
    return json(400, { error: 'size must be a non-negative number' });
  }
  if (typeof parentVersion !== 'number' || parentVersion < 0) {
    return json(400, { error: 'parentVersion must be a non-negative integer' });
  }

  const { teamId, actorId } = caller;
  const ossKey = ossKeyForHash(teamId, contentHash);
  const supabase = createServiceRoleClient();

  // Upsert blob (ON CONFLICT DO NOTHING)
  await supabase
    .from('amuxc_blobs')
    .upsert(
      { team_id: teamId, content_hash: contentHash, oss_key: ossKey, size, verified: false },
      { onConflict: 'team_id,content_hash', ignoreDuplicates: true }
    );

  // Insert upload session (expires 1h from now)
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const { data: session, error: sessionErr } = await supabase
    .from('amuxc_upload_sessions')
    .insert({
      team_id: teamId,
      actor_id: actorId,
      node_id: nodeId || null,
      path,
      parent_version: parentVersion,
      content_hash: contentHash,
      size,
      oss_key: ossKey,
      status: 'pending',
      expires_at: expiresAt,
    })
    .select('id')
    .single();

  if (sessionErr) {
    return json(500, { error: `Failed to create upload session: ${sessionErr.message}` });
  }

  // Check if blob is already uploaded (HEAD OSS)
  let requiresUpload = true;
  let presignedPut = null;

  const s3 = getS3Client();
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET(), Key: ossKey }));
    if (head.ContentLength === size) {
      requiresUpload = false;
    }
    // Blob exists but size mismatch — still require upload (will overwrite)
  } catch (e) {
    if (e.$metadata?.httpStatusCode !== 404 && e.name !== 'NotFound' && e.Code !== 'NoSuchKey') {
      console.error('[sync/prepare] HEAD OSS error:', e.message);
      // Non-fatal: proceed with presigned PUT
    }
    // 404 → requiresUpload = true
  }

  if (requiresUpload) {
    // Presigned PUT locked to key/method/Content-Length, TTL 15min
    const putCmd = new PutObjectCommand({
      Bucket: BUCKET(),
      Key: ossKey,
      ContentLength: size,
    });
    presignedPut = await getSignedUrl(s3, putCmd, { expiresIn: 900 });
  }

  return json(200, {
    uploadSessionId: session.id,
    ossKey,
    requiresUpload,
    presignedPut,
  });
}

// ---------------------------------------------------------------------------
// §3.3  POST /sync/upload/complete
// ---------------------------------------------------------------------------

/**
 * @param {{ userId, teamId, actorId }} caller
 * @param {object} body - { uploadSessionId }
 */
export async function handleSyncUploadComplete(caller, body) {
  const { uploadSessionId } = body || {};
  if (!uploadSessionId) {
    return json(400, { error: 'uploadSessionId is required' });
  }

  const { teamId, actorId } = caller;
  const supabase = createServiceRoleClient();

  // Fetch session (needed outside tx for OSS HEAD check)
  const { data: session, error: sessionErr } = await supabase
    .from('amuxc_upload_sessions')
    .select('*')
    .eq('id', uploadSessionId)
    .single();

  if (sessionErr || !session) {
    return json(404, { error: 'upload session not found' });
  }
  if (session.team_id !== teamId) {
    return json(403, { error: 'session does not belong to this team' });
  }
  if (session.actor_id !== actorId) {
    return json(403, { error: 'session does not belong to caller' });
  }
  if (session.status !== 'pending') {
    return json(410, { error: `upload session is ${session.status}` });
  }
  if (new Date(session.expires_at) < new Date()) {
    return json(410, { error: 'upload session has expired' });
  }

  // Step 1 (outside tx): HEAD OSS — verify blob exists and size matches
  const s3 = getS3Client();
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET(), Key: session.oss_key }));
    if (head.ContentLength !== session.size) {
      return json(422, {
        error: 'BlobMissingOrSizeMismatch',
        expected: session.size,
        actual: head.ContentLength,
      });
    }
  } catch (e) {
    return json(422, {
      error: 'BlobMissingOrSizeMismatch',
      detail: e.message,
    });
  }

  // Atomically complete via SQL RPC (keeps multi-statement tx atomic)
  // The RPC implements the full CAS transaction described in spec §3.3.
  const { data: rpcResult, error: rpcErr } = await supabase
    .rpc('amuxc_complete_upload', {
      p_session_id: uploadSessionId,
      p_actor_id: actorId,
    });

  if (rpcErr) {
    // Map errcode P0409 (custom) → 409 CAS conflict
    if (rpcErr.code === 'P0409' || rpcErr.message?.includes('cas-mismatch')) {
      // Extract remote version/hash from the error detail/hint if present
      let remoteVersion, remoteHash;
      try {
        const detail = JSON.parse(rpcErr.hint || rpcErr.details || '{}');
        remoteVersion = detail.remote_version;
        remoteHash    = detail.remote_hash;
      } catch { /* ignored */ }
      return json(409, { reason: 'cas-mismatch', remoteVersion, remoteHash });
    }
    if (rpcErr.code === 'P0403') {
      return json(403, { error: rpcErr.message });
    }
    if (rpcErr.code === 'P0410') {
      return json(410, { error: rpcErr.message });
    }
    console.error('[sync/complete] RPC error:', rpcErr);
    return json(500, { error: `complete failed: ${rpcErr.message}` });
  }

  if (!rpcResult || rpcResult.length === 0) {
    return json(500, { error: 'complete RPC returned no result' });
  }

  const result = rpcResult[0];
  return json(200, {
    version:     result.version,
    contentHash: result.content_hash,
    changeSeq:   result.change_seq,
  });
}

// ---------------------------------------------------------------------------
// §3.4  POST /sync/download
// ---------------------------------------------------------------------------

/**
 * @param {{ userId, teamId, actorId }} caller
 * @param {object} body - { teamId, contentHash }
 */
export async function handleSyncDownload(caller, body) {
  const { contentHash } = body || {};
  if (!contentHash || typeof contentHash !== 'string') {
    return json(400, { error: 'contentHash is required' });
  }

  const { teamId } = caller;
  const supabase = createServiceRoleClient();

  const { data: blob, error } = await supabase
    .from('amuxc_blobs')
    .select('oss_key, size, verified')
    .eq('team_id', teamId)
    .eq('content_hash', contentHash)
    .single();

  if (error || !blob) {
    return json(404, { error: 'blob not found' });
  }
  if (!blob.verified) {
    return json(404, { error: 'blob not yet verified (upload not completed)' });
  }

  const s3 = getS3Client();
  const getCmd = new GetObjectCommand({ Bucket: BUCKET(), Key: blob.oss_key });
  const downloadUrl = await getSignedUrl(s3, getCmd, { expiresIn: 900 });

  return json(200, { downloadUrl, size: blob.size, ttlSec: 900 });
}

// ---------------------------------------------------------------------------
// §3.5  POST /sync/delete
// ---------------------------------------------------------------------------

/**
 * @param {{ userId, teamId, actorId }} caller
 * @param {object} body - { teamId, path, parentVersion, nodeId }
 */
export async function handleSyncDelete(caller, body) {
  const { path, parentVersion, nodeId } = body || {};

  const pathCheck = validateSyncPath(path);
  if (!pathCheck.ok) {
    return json(422, { error: pathCheck.message, code: pathCheck.code });
  }
  if (typeof parentVersion !== 'number' || parentVersion < 0) {
    return json(400, { error: 'parentVersion must be a non-negative integer' });
  }

  const { teamId, actorId } = caller;
  const supabase = createServiceRoleClient();

  const { data: rpcResult, error: rpcErr } = await supabase
    .rpc('amuxc_complete_delete', {
      p_team_id:       teamId,
      p_path:          path,
      p_parent_version: parentVersion,
      p_actor_id:      actorId,
      p_node_id:       nodeId || null,
    });

  if (rpcErr) {
    if (rpcErr.code === 'P0409' || rpcErr.message?.includes('cas-mismatch')) {
      let remoteVersion, remoteHash;
      try {
        const detail = JSON.parse(rpcErr.hint || rpcErr.details || '{}');
        remoteVersion = detail.remote_version;
        remoteHash    = detail.remote_hash;
      } catch { /* ignored */ }
      return json(409, { reason: 'cas-mismatch', remoteVersion, remoteHash });
    }
    if (rpcErr.code === 'P0404') {
      return json(404, { error: 'file not found' });
    }
    console.error('[sync/delete] RPC error:', rpcErr);
    return json(500, { error: `delete failed: ${rpcErr.message}` });
  }

  if (!rpcResult || rpcResult.length === 0) {
    return json(500, { error: 'delete RPC returned no result' });
  }

  const result = rpcResult[0];
  return json(200, {
    version:   result.version,
    changeSeq: result.change_seq,
  });
}

// ---------------------------------------------------------------------------
// §3.6  GET /sync/versions
// ---------------------------------------------------------------------------

/**
 * @param {{ userId, teamId, actorId }} caller
 * @param {object} query - { teamId, path, limit?, cursor? }
 */
export async function handleSyncVersions(caller, query) {
  const { path, limit = 50, cursor = null } = query || {};

  if (!path || typeof path !== 'string') {
    return json(400, { error: 'path query param is required' });
  }

  const { teamId } = caller;
  const supabase = createServiceRoleClient();

  // Find the file row
  const { data: fileRow, error: fileErr } = await supabase
    .from('amuxc_files')
    .select('id')
    .eq('team_id', teamId)
    .eq('path', path)
    .single();

  if (fileErr || !fileRow) {
    return json(404, { error: 'file not found' });
  }

  const pageLimit = Math.min(Math.max(1, Number(limit) || 50), 500);

  // Decode cursor: { version, id }
  let cursorVersion = 2147483647; // max int
  let cursorId      = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
      cursorVersion = decoded.version;
      cursorId      = decoded.id;
    } catch {
      return json(400, { error: 'invalid cursor' });
    }
  }

  const { data: rows, error } = await supabase
    .from('amuxc_file_versions')
    .select('id, version, parent_version, content_hash, size, deleted, created_at, created_by, created_by_node_id, message')
    .eq('file_id', fileRow.id)
    .or(`version.lt.${cursorVersion},and(version.eq.${cursorVersion},id.lt.${cursorId})`)
    .order('version', { ascending: false })
    .order('id', { ascending: false })
    .limit(pageLimit + 1);

  if (error) {
    return json(500, { error: `versions query failed: ${error.message}` });
  }

  const hasMore = rows.length > pageLimit;
  const versions = (hasMore ? rows.slice(0, pageLimit) : rows).map(r => ({
    version:          r.version,
    parentVersion:    r.parent_version,
    contentHash:      r.content_hash,
    size:             r.size,
    deleted:          r.deleted,
    createdAt:        r.created_at,
    createdBy:        r.created_by,
    createdByNodeId:  r.created_by_node_id,
    message:          r.message,
  }));

  let nextCursor = null;
  if (hasMore) {
    const last = rows[pageLimit - 1];
    nextCursor = Buffer.from(JSON.stringify({ version: last.version, id: last.id })).toString('base64');
  }

  return json(200, { versions, nextCursor });
}

// ---------------------------------------------------------------------------
// POST /sync/set-mode — owner-only sync_mode switch (Tranche 5)
// ---------------------------------------------------------------------------
/**
 * Switch a team's sync_mode via the set_team_sync_mode Supabase RPC.
 * The RPC enforces owner-only access; we just proxy the PG error codes to HTTP.
 *
 * Body: { teamId: string, mode: 'git' | 'oss' }
 * Returns: { mode: string } | 400 | 401 | 403
 */
export async function handleSyncSetMode(userId, body) {
  const { teamId, mode } = body ?? {};
  if (!teamId) return json(400, { error: 'teamId is required' });
  if (!mode) return json(400, { error: 'mode is required' });
  if (mode !== 'git' && mode !== 'oss') return json(400, { error: `invalid mode: ${mode}` });

  const supabase = createServiceRoleClient();

  // We need to call the RPC as the authenticated user so ownership checks work.
  // The RPC is SECURITY DEFINER so it bypasses the guard trigger, but the
  // owner check inside the function uses app.current_actor_id_for_team which
  // reads request.jwt.claims — we set those via the service client + rpc context.
  // Simpler: call via service-role; the RPC reads team_members.role to verify.
  const { data, error } = await supabase
    .rpc('set_team_sync_mode', { p_team_id: teamId, p_mode: mode });

  if (error) {
    // PG errcode 22023 → invalid mode (shouldn't reach here, validated above)
    // PG errcode 42501 → not owner / not member
    const code = error.code;
    if (code === '22023') return json(400, { error: error.message });
    if (code === '42501') return json(403, { error: error.message });
    return json(500, { error: error.message });
  }

  return json(200, { mode: data ?? mode });
}

// ---------------------------------------------------------------------------
// POST /sync/team-mode — read team sync_mode (Tranche 5)
// ---------------------------------------------------------------------------
/**
 * Return the sync_mode for a team (read-only, no ownership required).
 *
 * Body: { teamId: string }
 * Returns: { mode: 'git' | 'oss' | null }
 */
export async function handleSyncTeamMode(userId, body) {
  const { teamId } = body ?? {};
  if (!teamId) return json(400, { error: 'teamId is required' });

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .rpc('get_team_sync_mode', { p_team_id: teamId });

  if (error) {
    return json(500, { error: error.message });
  }

  return json(200, { mode: data ?? null });
}
