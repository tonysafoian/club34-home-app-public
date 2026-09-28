import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { storage } from "./storage";
import "./types";
import { query } from "./lib/db.js";

const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || (() => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET or SESSION_SECRET must be set in production");
  }
  console.warn("[AUTH] WARNING: Using default JWT secret. Set JWT_SECRET env var for production.");
  return "club34-dev-secret-change-in-production";
})();
const JWT_EXPIRY = "7d";

export interface AuthUser {
  userId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  roles: string[];
  approvalStatus: string;
}

export function generateToken(user: AuthUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): AuthUser | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthUser;
  } catch {
    return null;
  }
}

export function setAuthCookie(res: Response, token: string): void {
  res.cookie("auth_token", token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie("auth_token", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  });
}

export function getAuthUser(req: Request): AuthUser | null {
  const cookieToken = req.cookies?.auth_token;
  if (cookieToken) {
    const user = verifyToken(cookieToken);
    if (user) return user;
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7);
    if (bearerToken) {
      const user = verifyToken(bearerToken);
      if (user) return user;
    }
  }

  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  req.user = user;
  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = getAuthUser(req);
    if (!user) {
      console.warn(`[auth] 401 ${req.method} ${req.path} — no authenticated user`);
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const hasRequiredRole = roles.some((role) => user.roles.includes(role));
    if (!hasRequiredRole) {
      console.warn(`[auth] 403 ${req.method} ${req.path} — user=${user.email} roles=[${user.roles}] required=[${roles}]`);
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    req.user = user;
    next();
  };
}

export function requireApproved(req: Request, res: Response, next: NextFunction): void {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (user.approvalStatus !== "approved") {
    res.status(403).json({ error: "Account not yet approved" });
    return;
  }
  req.user = user;
  next();
}

// Link a tt_workers row to a profile UUID on first / re-login.
async function linkWorkerProfile(profileId: string, email: string): Promise<void> {
  try {
    await query(
      `UPDATE tt_workers SET user_id = $1 WHERE email = $2 AND user_id IS NULL`,
      [profileId, email.toLowerCase()]
    );
  } catch (e) {
    console.warn("[AUTH] Could not link worker profile:", e);
  }
}

export async function handleNewUser(oauthProfile: {
  userId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}): Promise<AuthUser> {
  const existingProfile = await storage.getProfileByUserId(oauthProfile.userId);

  if (existingProfile) {
    const invite = await storage.getInvitedEmail(oauthProfile.email);
    let status = existingProfile.approvalStatus;
    if (status !== "approved" && invite) {
      await storage.updateProfile(oauthProfile.userId, { approvalStatus: "approved" });
      status = "approved";
    }
    const roles = await storage.getUserRoles(oauthProfile.userId);
    const roleNames = roles.map((r) => r.role);

    // Ensure worker linkage is current
    if (roleNames.includes("worker")) {
      await linkWorkerProfile(existingProfile.id, oauthProfile.email);
    }

    return {
      userId: oauthProfile.userId,
      email: oauthProfile.email,
      displayName: existingProfile.displayName,
      avatarUrl: existingProfile.avatarUrl,
      roles: roleNames,
      approvalStatus: status,
    };
  }

  const invite = await storage.getInvitedEmail(oauthProfile.email);
  const isWorkerInvite = invite?.role === "worker";

  let approvalStatus: "pending" | "approved" | "rejected";
  if (invite) {
    approvalStatus = "approved";
  } else {
    approvalStatus = "rejected";
  }

  const profile = await storage.createProfile({
    userId: oauthProfile.userId,
    displayName: oauthProfile.displayName || oauthProfile.email,
    avatarUrl: oauthProfile.avatarUrl,
    approvalStatus,
    phoneNumber: invite?.phoneNumber || null,
  });

  if (isWorkerInvite) {
    // Worker: role='worker', do NOT delete invite, link profile to tt_workers
    await storage.createUserRole({ userId: oauthProfile.userId, role: "worker" });
    await linkWorkerProfile(profile.id, oauthProfile.email);
    return {
      userId: oauthProfile.userId,
      email: oauthProfile.email,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      roles: ["worker"],
      approvalStatus: "approved",
    };
  }

  // Regular household user
  const roleCount = await storage.countUserRoles();
  const role = roleCount === 0 ? "admin" : "member";
  await storage.createUserRole({ userId: oauthProfile.userId, role });

  if (invite) {
    await storage.deleteInvitedEmail(oauthProfile.email);
  }

  return {
    userId: oauthProfile.userId,
    email: oauthProfile.email,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    roles: [role],
    approvalStatus: profile.approvalStatus,
  };
}
