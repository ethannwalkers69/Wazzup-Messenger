export function notFound(req, res) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } });
}
export function errorHandler(err, req, res, next) {
  console.error(err);
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  res.status(status).json({ error: { code: err.code || "SERVER_ERROR", message: status === 500 ? "Something went wrong." : err.message } });
}
export function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}
