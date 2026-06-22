import { BaseModel } from "../models";

// Define schema interfaces matching standard auth payloads
export class AuthUser extends BaseModel {
  email!: string;
  emailVerified!: Date | null;
  name!: string | null;
  image!: string | null;
}

export class AuthAccount extends BaseModel {
  userId!: string;
  type!: string;
  provider!: string;
  providerAccountId!: string;
  refresh_token!: string | null;
  access_token!: string | null;
  expires_at!: number | null;
  token_type!: string | null;
  scope!: string | null;
  id_token!: string | null;
  session_state!: string | null;
}

export class AuthSession extends BaseModel {
  sessionToken!: string;
  userId!: string;
  expires!: Date;
}

export class VerificationToken extends BaseModel {
  identifier!: string;
  token!: string;
  expires!: Date;
}

/**
 * Next-Auth compliant adapter implementation for BullDB models.
 */
export function BullDBNextAuthAdapter(dbClient: any) {
  // Ensure DB client is mapped
  BaseModel.setDb(dbClient);

  return {
    async createUser(user: any) {
      const u = await AuthUser.create(user);
      return u.toJSON();
    },

    async getUser(id: string) {
      try {
        const u = await AuthUser.getById(id);
        return u.toJSON();
      } catch (err) {
        return null;
      }
    },

    async getUserByEmail(email: string) {
      const u = await AuthUser.findFirst({ email });
      return u ? u.toJSON() : null;
    },

    async getUserByAccount({ provider, providerAccountId }: { provider: string; providerAccountId: string }) {
      const acc = await AuthAccount.findFirst({ provider, providerAccountId });
      if (!acc) return null;
      try {
        const u = await AuthUser.getById(acc.userId);
        return u.toJSON();
      } catch (err) {
        return null;
      }
    },

    async updateUser(user: any) {
      const u = await AuthUser.getById(user.id);
      Object.assign(u, user);
      await u.save();
      return u.toJSON();
    },

    async linkAccount(account: any) {
      const acc = await AuthAccount.create(account);
      return acc.toJSON();
    },

    async createSession(session: any) {
      const s = await AuthSession.create(session);
      return s.toJSON();
    },

    async getSessionAndUser(sessionToken: string) {
      const s = await AuthSession.findFirst({ sessionToken });
      if (!s) return null;
      try {
        const u = await AuthUser.getById(s.userId);
        return {
          session: s.toJSON(),
          user: u.toJSON()
        };
      } catch (err) {
        return null;
      }
    },

    async updateSession(session: any) {
      const s = await AuthSession.findFirst({ sessionToken: session.sessionToken });
      if (!s) return null;
      Object.assign(s, session);
      await s.save();
      return s.toJSON();
    },

    async deleteSession(sessionToken: string) {
      const s = await AuthSession.findFirst({ sessionToken });
      if (s) {
        await s.delete();
      }
    },

    async createVerificationToken(verificationToken: any) {
      const token = await VerificationToken.create(verificationToken);
      return token.toJSON();
    },

    async useVerificationToken({ identifier, token }: { identifier: string; token: string }) {
      const t = await VerificationToken.findFirst({ identifier, token });
      if (!t) return null;
      await t.delete();
      return t.toJSON();
    }
  };
}

/**
 * Better-Auth adapter configuration utility.
 */
export function createBetterAuthPlugin(dbClient: any) {
  return {
    id: "bulldb-adapter",
    init: () => {
      BaseModel.setDb(dbClient);
    },
    // exposes schemas mapping hooks
    getModels: () => ({
      user: AuthUser,
      session: AuthSession,
      account: AuthAccount,
      verificationToken: VerificationToken
    })
  };
}
