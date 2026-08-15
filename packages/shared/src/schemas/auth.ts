import { z } from 'zod'
import { Phases } from './common.js'

/** `POST /auth/login` — proxied to Easee; the password is never stored or logged. */
export const LoginRequest = z.object({
  userName: z.string().min(1),
  password: z.string().min(1),
})
export type LoginRequest = z.infer<typeof LoginRequest>

export const RefreshRequest = z.object({
  refreshToken: z.string().min(1),
})
export type RefreshRequest = z.infer<typeof RefreshRequest>

/** A charger the caller is mapped to, per `parkingLots` (FR-003, FR-004). */
export const MappedCharger = z.object({
  lotNumber: z.string().min(1),
  chargerId: z.string().min(1),
  phases: Phases,
  maxCurrentA: z.number().positive(),
})
export type MappedCharger = z.infer<typeof MappedCharger>

export const AuthenticatedUser = z.object({
  userId: z.string().min(1),
  email: z.string().optional(),
})
export type AuthenticatedUser = z.infer<typeof AuthenticatedUser>

export const LoginResponse = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
  user: AuthenticatedUser,
  chargers: z.array(MappedCharger),
})
export type LoginResponse = z.infer<typeof LoginResponse>

/** The claims this system relies on, per the O2 spike (research R6). */
export const EaseeTokenClaims = z.object({
  UserId: z.string().min(1),
  email: z.string().optional(),
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number().optional(),
})
export type EaseeTokenClaims = z.infer<typeof EaseeTokenClaims>
