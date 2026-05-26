import type { IdeasBackend } from "../types";

function notImplemented(operation: string): never {
  throw new Error(`${operation} backend not implemented`);
}

export function createSupabaseIdeasBackend(_client: unknown): IdeasBackend {
  return {
    listIdeas: async () => notImplemented("ideas.listIdeas"),
    getIdeaDetail: async () => notImplemented("ideas.getIdeaDetail"),
    createIdea: async () => notImplemented("ideas.createIdea"),
    updateIdea: async () => notImplemented("ideas.updateIdea"),
    archiveIdea: async () => notImplemented("ideas.archiveIdea"),
    createIdeaActivity: async () => notImplemented("ideas.createIdeaActivity"),
  };
}
