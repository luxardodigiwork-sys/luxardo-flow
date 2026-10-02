# LUXARDO FLOW — local browser test kit

Runs the real Flow app against **local Firebase emulators** (never the live
`luxardo-flow` project), logs in as every role and checks that every visible
link and button actually works. Use this before every deploy and after every
fix — an AI agent can run it too, so "it works on my side" is always checked.

## One-time setup
```bash
npm ci && (cd functions && npm ci) && (cd functions-loom && npm ci && npm run build)
npm i -g firebase-tools        # needs Java 11+ for the Firestore emulator
cd qa-e2e && npm i && npx playwright install chromium && cd ..
```

## Run
```bash
# 1. emulators (terminal 1)
firebase emulators:start --config firebase.e2e.json --project demo-luxardo-flow

# 2. build the Flow app pointed at the emulators (terminal 2)
cp qa-e2e/env.loom.e2e.example .env.loom        # back up your real .env.loom first!
npx vite build --mode loom && npx vite preview --mode loom --outDir dist-loom --port 4173

# 3. seed + test (terminal 3)
cd qa-e2e
npm run seed        # 11 test logins, password Test@12345
npm run flow        # design -> PR -> 3 pieces, through the real callables
npm run navcheck    # every role, every link: prints BROKEN: none when healthy
```

Restore your real `.env.loom` before building for deployment.

## Test logins (emulator only)
`owner@test.lux`, `admin@test.lux`, `designer@test.lux`, `pm@test.lux`,
`dispatch@test.lux`, `guard@test.lux`, `tailor@test.lux`, `store@test.lux`,
`accounts@test.lux`, `analysis@test.lux`, super admin `luxardodigiwork@gmail.com`
— all `Test@12345`. Owner/Admin/Super Admin sign in at `/admin/login`, everyone
else at `/login`.

## Known emulator limitation
Storage rules that look up the Firestore `staff/{uid}` role
(`firestore.exists/get` inside `storage.loom.rules`) always deny in the local
emulator here. Self-scoped paths (`production/profiles/{uid}`,
`production/tailor/{uid}/…`) work. Check role-based upload paths on a preview
channel before relying on them.
