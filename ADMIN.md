# Admin Mode — Decisions and Plan

## ONVIF: not needed

ONVIF was mentioned in early planning notes as a prerequisite for admin features.
This is incorrect. The `reolink-nvr-api` SDK uses Reolink's native HTTPS API
(`POST /cgi-bin/api.cgi`) for everything. ONVIF is a third-party interoperability
protocol (SOAP/HTTP, separate port) used by NVR software like Blue Iris or Milestone.
It adds significant complexity and is not required for any feature we plan to build.

**Decision: ignore ONVIF entirely.** All admin features use `client.api()`.


## Auth: admin-only route guard

The `admin` role is already wired in the auth middleware — `res.locals['role']` is
set from the cookie on every authenticated request. Admin-only API routes just need:

```typescript
if (res.locals['role'] !== 'admin') {
  res.status(403).json({ error: 'Admin access required' });
  return;
}
```

This will be extracted into a small `requireAdmin` middleware in `src/app.ts` when
the first admin route is added.


## UI: separate /admin page

Admin operations are categorically different from viewing — they manage the hub and
cameras rather than watching them. A separate route and page keeps the viewer
experience clean for family members and makes permission enforcement obvious.

- **Viewer role:** no link to admin, 403 on any `/api/admin/*` request
- **Admin role:** link to admin page shown in sidebar; full `/admin` page with its
  own layout

The admin page will not reuse the focused-camera card layout. It will be a
full-width management interface with sections for hub status, camera management,
and event history.


## Feature discovery: GetAbility must come first

Before building any admin feature we need to know what the Hub Pro actually reports
as supported. The SDK exposes this as `client.api('GetAbility')`.

**First thing to do in the first admin session:** add a `GET /api/admin/ability`
endpoint, call it against the real hub, and log/display the full response. This
tells us:
- Which cameras support PTZ
- What AI detection is available per channel
- What motion detection config is supported
- Encoding capabilities

Everything below is planned assuming reasonable capability support. GetAbility
results may revise priorities.


## Feature tiers

### Tier 1 — Foundation (build in session 1, no capability unknowns)

These don't depend on GetAbility results:

1. **`requireAdmin` middleware** — extracted helper, tested, used by all admin routes
2. **`GET /api/admin/ability`** — calls `GetAbility`, returns full JSON; used to
   discover capabilities and drive the admin dashboard
3. **Admin page scaffold** — `/admin` route serving `public/admin.html`; shows hub
   info (already have from `/api/device-info`), raw capability flags from
   `/api/admin/ability`, and per-camera channel status (already have from
   `/api/devices`)

### Tier 2 — Event history (session 2, highest unique value)

Matthew noticed the Reolink Android app has a cross-camera **Event history** view.
This is the most compelling feature: recordings search across all cameras in a single
reverse-chronological list with thumbnails, date range, event type, and camera filters.

We already have the single-camera `Search` API working. The event history extends it:
- Call `Search` across all named channels in parallel
- Merge and sort results by timestamp descending
- Show thumbnail (from existing `/api/snapshot/:channel`), timestamp, event type,
  camera name, duration
- Filter controls: date range (date only, not time), event type, which cameras

**What needs hub testing first:** what event types does the Hub Pro include in Search
results? The Android app showed more event types than appear in the per-camera
recordings list. We need to inspect a real Search response to understand the `type`
field on File entries and whether hub-level events (not camera recordings) appear.

API shape we expect to add:
```
GET /api/admin/events?start=DATE&end=DATE&channels=0,1,2&types=...
```

### Tier 3 — PTZ (session 3+, depends on GetAbility results)

The SDK has full PTZ support: `getPtzPreset`, `setPtzPreset`, `ptzCtrl`, `getPtzGuard`,
`getPtzPatrol`, and control operations (Left/Right/Up/Down/ToPos/StartPatrol).

**Prerequisite:** GetAbility must confirm at least one connected camera supports PTZ.
Current cameras (back door, garage, front door) appear to be fixed-mount. Matthew
plans to add more cameras — PTZ may become relevant later.

If PTZ is supported: add per-camera PTZ panel in the admin page (directional pad,
preset list, guard mode toggle).

### Tier 4 — Encoding and detection config (session 3+)

The SDK exposes `GetEnc` (video encoding settings per channel) and `GetAiCfg` /
`SetAiCfg` (AI detection config: person, vehicle, pet, sensitivity). These are
read/write operations and carry risk of misconfiguring live cameras.

**Plan:** read-only display first; write operations only after we understand the
response shape and have confidence in the API.


## What can be built without hub testing

These can be implemented and tested (with mocks) before touching the real hub:

- `requireAdmin` middleware and its tests
- Admin page HTML/CSS/JS scaffold (no data)
- Route stubs returning 403 to non-admin users
- Client-side admin page layout and navigation

## What requires the real hub

- `GetAbility` response structure (to know what to display)
- Event history `Search` response shape (event types, cross-camera behaviour)
- PTZ capability confirmation
- Any `Set*` operation (only after reading current config successfully)


## SDK capabilities summary

All via `client.api(command, params)` unless noted:

| Command | SDK helper | Purpose |
|---|---|---|
| `GetAbility` | `getAbility(client)` in endpoints/system | Capability discovery |
| `GetDevInfo` | `getDevInfo(client)` | Already used |
| `GetEnc` | `getEnc(client, channel)` | Encoding config |
| `GetAlarm` | `getAlarm(client)` in alarm module | Alarm config |
| `GetMdState` | `getMdState(client, channel)` | Live motion state |
| `GetAiCfg` | `getAiCfg(client, channel)` | AI detection config |
| `GetAiState` | `getAiState(client, channel)` | Live AI detection state |
| `GetPtzPreset` | `getPtzPreset(client, channel)` | PTZ preset list |
| `PtzCtrl` | `ptzCtrl(client, params)` | PTZ movement |
| `Search` | direct `client.api` (already working) | Recording/event search |
| `GetChannelstatus` | direct `client.api` (already used) | Camera list |
