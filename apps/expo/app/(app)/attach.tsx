import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";

import { useOnboarding } from "../_layout";
import { uploadAttachment } from "../../src/features/sessions/attachment-upload";
import { appendPendingAttachment } from "../../src/features/sessions/pending-attachments";
import {
  AttachmentDrawerSheet,
  type AttachmentSource,
} from "../../src/features/sessions/screens/AttachmentDrawerSheet";
import { supabase } from "../../src/lib/supabase/client";

type PickedAsset = {
  uri: string;
  mime?: string;
};

export default function AttachRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const params = useLocalSearchParams<{ sessionId?: string }>();
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
  const teamId = state.currentTeam?.id ?? "";
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const persist = async (assets: PickedAsset[]) => {
    if (!teamId || !sessionId) {
      setErrorMessage("Open a session before attaching files.");
      return;
    }
    setIsUploading(true);
    try {
      for (const asset of assets) {
        const uploaded = await uploadAttachment(supabase, {
          teamId,
          sessionId,
          localUri: asset.uri,
          fallbackMime: asset.mime ?? "application/octet-stream",
        });
        appendPendingAttachment(teamId, sessionId, uploaded);
      }
      router.back();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Couldn't upload the file.");
    } finally {
      setIsUploading(false);
    }
  };

  const handlePick = async (source: AttachmentSource) => {
    setErrorMessage(null);
    try {
      if (source === "files") {
        const result = await DocumentPicker.getDocumentAsync({
          copyToCacheDirectory: true,
          multiple: false,
        });
        if (result.canceled || result.assets.length === 0) return;
        await persist(
          result.assets.map((asset) => ({ uri: asset.uri, mime: asset.mimeType ?? undefined })),
        );
        return;
      }

      if (source === "camera") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          setErrorMessage("Camera permission denied.");
          return;
        }
        const result = await ImagePicker.launchCameraAsync({
          allowsEditing: false,
          quality: 0.85,
        });
        if (result.canceled || result.assets.length === 0) return;
        await persist(
          result.assets.map((asset) => ({ uri: asset.uri, mime: asset.mimeType ?? undefined })),
        );
        return;
      }

      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setErrorMessage("Photo library permission denied.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: false,
        allowsMultipleSelection: true,
        selectionLimit: 5,
        quality: 0.85,
      });
      if (result.canceled || result.assets.length === 0) return;
      await persist(
        result.assets.map((asset) => ({ uri: asset.uri, mime: asset.mimeType ?? undefined })),
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Couldn't open the picker.",
      );
    }
  };

  return (
    <AttachmentDrawerSheet
      errorMessage={errorMessage ?? (isUploading ? "Uploading…" : null)}
      onClose={() => router.back()}
      onPickSource={handlePick}
    />
  );
}
