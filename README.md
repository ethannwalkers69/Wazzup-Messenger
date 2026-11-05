# Wazzup Messenger

A mobile-first group messaging web app built with HTML, Tailwind CSS, vanilla JavaScript, Node.js 20, Express 4, and Neon PostgreSQL.

## Setup

Requirements: Node.js 20+, npm, and a Neon PostgreSQL database. This project has no third-party messaging, auth, payment, or storage API integrations. The app's own Express REST routes are internal endpoints required by the browser frontend.

```bash
npm install
cp .env.example .env
```

Fill in the environment variables. `DATABASE_URL` should be the Neon connection string with `?sslmode=require`.

## Env vars

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `JWT_SECRET` | Long random secret used to sign sessions |
| `NODE_ENV` | `development` or `production` |
| `LEADER_PASSWORD` | Initial password for the Leader account |
| `LEADER_EMAIL` | The one reserved Leader email |
| `PORT` | Optional local port; Render supplies it |

Use a unique `JWT_SECRET` of at least 32 random characters. Never commit `.env`.

## DB migration

Run:

```bash
npm run migrate
```

The migration creates `citext`, the role enums, tables, constraints, and indexes. The database user must have permission to create the extension; Neon generally supports `citext`. If your Neon role cannot create it, enable the extension from the Neon SQL Editor first.

The server seeds the Leader account on boot. Run the migration before starting the server.

## Run locally

```bash
npm run dev
```

Open `http://localhost:3000`. Register a regular account or sign in using `LEADER_EMAIL` and `LEADER_PASSWORD`.

## Deploy to Render

1. Push this repository to GitHub.
2. Create a Neon database and copy its pooled or direct connection string with `sslmode=require`.
3. In Render, create a Web Service from the repository. The included `render.yaml` sets the build and start commands.
4. Set `DATABASE_URL`, `LEADER_EMAIL`, and `LEADER_PASSWORD` in Render's environment settings. Render generates `JWT_SECRET` from the blueprint.
5. Set the Render Start Command to `npm run migrate && npm start` so the idempotent schema migration runs before the server starts. If you use the included Blueprint, this is already configured in `render.yaml`.
6. Deploy and check `/health`.

**Persistent uploads:** this implementation writes images to `public/uploads`. Render's ordinary filesystem is ephemeral and may be cleared on deploy/restart. Attach a Render persistent disk and mount it at the upload directory, or replace the local upload adapter with durable object storage before relying on user images in production. No external storage API is included.

## Auth model

There is one `users` table for every account type. Regular users sign up with `email`, `first_name`, `last_name`, and `password`. Their initial `display_name` is derived from first and last name and can later be edited in the profile. All accounts log in with **email and password only**.

There is exactly one Leader identity, selected by `LEADER_EMAIL`. On boot, if the email does not exist, the app creates it using `LEADER_PASSWORD`; if it exists, its account role is set to `leader` without changing its password. The Leader therefore retains the existing password when the environment password is rotated; change the database password hash through a controlled maintenance operation if rotation is required. The Leader bypasses group admin checks and is protected from being kicked or leaving groups. Only the Leader can promote group admins and toggle premium.

## Security notes

- Passwords use bcrypt cost 12.
- Session JWT is stored in an httpOnly cookie; production cookies are Secure and SameSite=Lax.
- Mutating authenticated routes require a double-submit CSRF cookie/header pair.
- Auth routes are rate-limited to 10 requests per minute per IP.
- SQL uses parameterized values. Dynamic SQL identifiers are selected only from fixed allowlists.
- Helmet security headers, JSON body limits, upload size limits, MIME and magic-byte checks are enabled.
- Images are limited to 2 MB for free accounts and 10 MB for premium accounts.
- Never expose `DATABASE_URL`, `JWT_SECRET`, or `LEADER_PASSWORD` to browser code.
- Configure HTTPS at the hosting layer. Use a persistent disk for uploads on Render.

## Assumptions

- “No API” means no external/third-party APIs or API keys. The app retains its own Express REST endpoints because the browser needs a server interface.
- Group membership invitations can only add an existing Wazzup account by email.
- Premium is a manually toggled database flag; there is no billing integration.
- Image uploads are stored locally under `public/uploads`; durable persistence requires a mounted disk.
- Group images can be set by URL in group settings; profile avatars can be selected and uploaded in the profile modal.
- Message editing is not included; the contract only requests message deletion.
- Message polling fetches the latest 70 messages every three seconds. Older-history pagination can be added using the `before` query parameter.
- The app uses CDN Tailwind and Google Fonts for convenience; neither is an application API. For fully offline assets, compile Tailwind locally and self-host Inter.
- The visual counters are illustrative landing-page content, not live usage metrics.

## Known limitations & next steps

- Polling is used instead of WebSockets. Upgrade to Socket.IO or native WebSockets when live delivery at scale is needed.
- Render local filesystem uploads need a persistent disk. A dedicated object-storage adapter is recommended for multi-instance scaling.
- Add automated integration tests, email verification, password reset, account deletion, upload cleanup, and audit logging before a public production launch.
- Add pagination UI, group image upload controls, stronger avatar URL validation, and a complete focus-trap implementation for dialogs.
- Tailwind CDN is convenient for initial deployment but a production build should compile and purge CSS.

## Acceptance checklist: implementation notes

| Requirement | Status | Notes |
|---|---|---|
| Signup/login/logout cookie session | Implemented | JWT httpOnly cookie; CSRF token issued on auth |
| Leader seed and email/password login | Implemented | Boot seed; existing password preserved |
| Create group/add user/promote/kick/leave | Implemented | Server-side role and last-admin checks |
| Text/image/reply/reactions | Implemented | Upload route; six allowed reactions |
| Edit group name and own nickname/profile | Implemented | Group/profile endpoints |
| Leader premium toggle | Implemented | Leader-only endpoint |
| Premium upload limit | Implemented | 2 MB free / 10 MB premium |
| Responsive 375/768/1280 layouts | Designed | CSS breakpoints; verify on target devices |
| Reduced motion and keyboard access | Partial | Reduced motion and visible focus; full dialog focus trap remains a production hardening item |
| Render + Neon configuration | Prepared | Migration and persistent upload disk are operator steps |

This is a deployable baseline, not a claim of a completed external security audit or Lighthouse certification. Run the app against a staging Neon database and complete the manual QA checklist before inviting real users.
