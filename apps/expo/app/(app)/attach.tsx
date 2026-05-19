import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useState } from "react";

import {
  AttachmentDrawerSheet,
  type AttachmentSource,
} from "../../src/features/sessions/screens/AttachmentDrawerSheet";

export default function AttachRoute() {
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handlePick = async (source: AttachmentSource) => {
    setErrorMessage(null);
    try {
      if (source === "files") {
        const result = await DocumentPicker.getDocumentAsync({
          copyToCacheDirectory: true,
          multiple: false,
        });
        if (!result.canceled) {
          router.back();
        }
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
        if (!result.canceled) {
          router.back();
        }
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
      if (!result.canceled) {
        router.back();
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Couldn't open the picker.",
      );
    }
  };

  return (
    <AttachmentDrawerSheet
      errorMessage={errorMessage}
      onClose={() => router.back()}
      onPickSource={handlePick}
    />
  );
}
