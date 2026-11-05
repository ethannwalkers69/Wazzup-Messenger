import jwt from "jsonwebtoken";

export function createToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
}
export function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000
  };
}
export function setSession(res, user) {
  res.cookie("wazzup_session", createToken(user), cookieOptions());
}
export function clearSession(res) {
  res.clearCookie("wazzup_session", { ...cookieOptions(), maxAge: undefined });
}
export function setCsrf(res, token) {
  res.cookie("csrfToken", token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/"
  });
}
