import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";

// Dependency messages and error objects can contain SQL parameters, including
// session bearers. Keep diagnostics useful without inspecting or serializing them.
function reportAuthDependencyFailure(level: "error" | "warn") {
  console.error(JSON.stringify({ level, event: "authentication.dependency-diagnostic" }));
}

export const safeAuthDependencyLogger: NonNullable<BetterAuthOptions["logger"]> = {
  level: "warn",
  log(level) {
    reportAuthDependencyFailure(level === "error" ? "error" : "warn");
  },
};

class AuthStorageFailure extends Error {
  constructor() {
    super("Authentication storage is unavailable.");
  }
}

export const durableSessionRevocation = {
  id: "controller-durable-session-revocation",
  endpoints: {
    signOut: createAuthEndpoint(
      "/sign-out",
      {
        method: "POST",
        requireHeaders: true,
      },
      async (ctx) => {
        const token = await ctx.getSignedCookie(
          ctx.context.authCookies.sessionToken.name,
          ctx.context.secret,
        );
        if (token) {
          try {
            // The selected primary database is the authority. Better Auth's
            // sign-out handler and hooked deletion both swallow storage failures;
            // direct adapter deletion propagates SELECT/DELETE failure instead.
            await ctx.context.adapter.delete({
              model: "session",
              where: [{ field: "token", value: token }],
            });
          } catch {
            reportAuthDependencyFailure("error");
            throw new AuthStorageFailure();
          }
        }
        // Clear cookies only after durable deletion has been acknowledged.
        deleteSessionCookie(ctx);
        return ctx.json({ success: true });
      },
    ),
  },
} satisfies BetterAuthPlugin;
