import { useEffect, useState } from 'react'
import { useOssSyncStore, type VersionInfo } from '@/stores/oss-sync'

interface Props {
  workspacePath: string
  path: string
}

export function VersionHistoryPanel({ workspacePath, path }: Props) {
  const [versions, setVersions] = useState<VersionInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const listVersions = useOssSyncStore((s) => s.listVersions)
  const restoreVersion = useOssSyncStore((s) => s.restoreVersion)

  useEffect(() => {
    setLoading(true)
    setError(null)
    listVersions(workspacePath, path)
      .then(setVersions)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [workspacePath, path, listVersions])

  return (
    <div className="oss-sync-version-history">
      <h3>Versions of {path}</h3>
      {loading && <p>Loading…</p>}
      {error && <p className="error">{error}</p>}
      <ul>
        {versions.map((v) => (
          <li key={v.version}>
            <span>
              v{v.version} &middot;{' '}
              {new Date(v.createdAt).toLocaleString()}{' '}
              {v.message ? <em>({v.message})</em> : null}
              {(v.createdBy || v.createdByNodeId) ? (
                <span className="oss-sync-version-author">
                  {' · by '}
                  {v.createdBy ?? v.createdByNodeId}
                </span>
              ) : null}
            </span>
            <button
              disabled={!v.contentHash}
              onClick={() => {
                if (v.contentHash) {
                  restoreVersion(workspacePath, path, v.contentHash).catch(
                    console.warn,
                  )
                }
              }}
            >
              Restore
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
