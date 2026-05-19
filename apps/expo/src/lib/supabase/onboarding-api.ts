import type { BootstrapResult, TeamSummary } from "../../features/onboarding/onboarding-types";

type QueryResult<T> = PromiseLike<{ data: T; error: { message?: string } | null }>;

type TeamMembershipRow = {
  member_id: string;
  role: string;
  teams: {
    id: string;
    name: string;
    slug: string;
  } | null;
};

type CreateTeamRpcRow = {
  team_id: string;
  team_name: string;
  team_slug: string;
  member_id: string;
  role: string;
  workspace_id: string;
  workspace_name: string;
};

type OnboardingClient = {
  auth: {
    getSession: () => Promise<{ data: { session: any | null }; error: { message?: string } | null }>;
    signInAnonymously: () => PromiseLike<{ data: { session?: any | null } | null; error: { message?: string } | null }>;
    signInWithOtp: (args: {
      email: string;
      options: { shouldCreateUser: boolean };
    }) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
    verifyOtp: (args: {
      email: string;
      token: string;
      type: "email";
    }) => PromiseLike<{ data: { session?: any | null } | null; error: { message?: string } | null }>;
    signOut: () => PromiseLike<{ error: { message?: string } | null }>;
  };
  from: (table: string) => {
    select: (columns: string) => any;
  };
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: any; error: { message?: string } | null }>;
};

function throwIfError(error: { message?: string } | null): void {
  if (error) {
    throw new Error(error.message ?? "Supabase request failed");
  }
}

function toTeamSummary(row: TeamMembershipRow): TeamSummary | null {
  if (!row.teams) return null;

  return {
    id: row.teams.id,
    name: row.teams.name,
    slug: row.teams.slug,
    role: row.role,
  };
}

export function createOnboardingApi(client: OnboardingClient) {
  return {
    async getCurrentSession() {
      const { data, error } = await client.auth.getSession();
      throwIfError(error);
      return data.session ?? null;
    },

    async loadBootstrap(): Promise<BootstrapResult> {
      const session = await this.getCurrentSession();
      const user = session?.user ?? null;

      if (!user?.id) {
        return {
          isAnonymous: false,
          team: null,
          memberActorId: null,
        };
      }

      const actorQuery = client.from("actors").select("id").eq("user_id", user.id).eq("actor_type", "member");
      const actorResult = await actorQuery;
      throwIfError(actorResult.error);

      const actorIds = (actorResult.data ?? []).map((row: { id: string }) => row.id);
      if (actorIds.length === 0) {
        return {
          isAnonymous: Boolean(user.is_anonymous),
          team: null,
          memberActorId: null,
        };
      }

      const membershipQuery = client
        .from("team_members")
        .select("member_id, role, teams!inner(id, name, slug)")
        .in("member_id", actorIds);
      const membershipResult = (await membershipQuery) as Awaited<QueryResult<TeamMembershipRow[]>>;
      throwIfError(membershipResult.error);

      const firstMembership = membershipResult.data?.find((row) => row.teams) ?? null;
      if (!firstMembership) {
        return {
          isAnonymous: Boolean(user.is_anonymous),
          team: null,
          memberActorId: null,
        };
      }

      return {
        isAnonymous: Boolean(user.is_anonymous),
        team: toTeamSummary(firstMembership),
        memberActorId: firstMembership.member_id,
      };
    },

    async signInAnonymously() {
      const { data, error } = await client.auth.signInAnonymously();
      throwIfError(error);
      return data;
    },

    async sendEmailOTP(email: string) {
      const { error } = await client.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
        },
      });
      throwIfError(error);

      return { pendingEmail: email };
    },

    async verifyOTP(email: string, token: string) {
      const { data, error } = await client.auth.verifyOtp({
        email,
        token,
        type: "email",
      });
      throwIfError(error);
      return data;
    },

    async createTeam(name: string): Promise<TeamSummary> {
      const result = await client.rpc("create_team", { p_name: name });
      throwIfError(result.error);

      const row = (Array.isArray(result.data) ? result.data[0] : result.data) as
        | CreateTeamRpcRow
        | null
        | undefined;
      if (!row) {
        throw new Error("create_team returned no team row");
      }

      return {
        id: row.team_id,
        name: row.team_name,
        slug: row.team_slug,
        role: row.role,
      };
    },

    async signOut() {
      const { error } = await client.auth.signOut();
      throwIfError(error);
    },
  };
}
