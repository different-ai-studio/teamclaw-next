import { useRouter } from "expo-router";

import { AttachmentDrawerSheet } from "../../src/features/sessions/screens/AttachmentDrawerSheet";

export default function AttachRoute() {
  const router = useRouter();
  return <AttachmentDrawerSheet onClose={() => router.back()} />;
}
