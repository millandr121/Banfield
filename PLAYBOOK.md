# Banfield — Plain-English Playbook

Everything you need to run, test, and publish the game, plus answers to the
stuff that's been confusing. Read top to bottom once; after that you'll only
need the command boxes.

---

## 1. The Codespace / "accept these changes" confusion

There are **two different things** that both say "pull" and it's easy to mix
them up:

### a) Git PULL (getting my code onto your machine)
When I (Claude) finish work, I **push commits to the branch
`claude/happy-noether-8i15T`**. Your Codespace has its own copy of that branch,
so until you *pull*, you're looking at the **old** code. That's why "it's the
old game still" kept happening.

**What to do:** whenever I say "I pushed", run this in the Codespace terminal:

```bash
git pull origin claude/happy-noether-8i15T
```

That's it. You do **not** need to click "accept" on a pile of popups — just run
that one command and you have my latest. Yes, these are *our* changes (the work
you asked me to do), so pulling them is always safe.

### b) GitHub PULL REQUEST (publishing a branch into `main`)
A "Pull Request" (PR) on github.com is a **separate** thing — it's a proposal to
merge our working branch into the `main` branch. The PRs piling up are just that
one proposal sitting open. You don't have to do anything with it until you're
happy with the game and want to make it official. When that day comes you click
**"Merge"** once on GitHub. Until then, ignore it.

### Why does VS Code keep nagging?
The blue/green "Source Control" badges show because your local copy and the
remote branch have drifted. The fix is always the same: `git pull` (box above).
You don't need to commit anything yourself — I do the committing. You're just
*receiving* the commits.

**TL;DR:** You pull. I commit & push. You merge the PR only at the very end.

---

## 2. Run it locally and test

From the project root (`/home/user/Banfield` or your Codespace folder):

```bash
# one-time, after the container starts or after I change package.json
nvm use 22        # the game needs Node 22 (Node 16 is too old)
npm install

# every time you want to play/test:
npm run dev
```

`npm run dev` builds the client and starts **two** servers at once:
- the game server (Cloudflare Worker, via `wrangler dev`) on port **8787**
- the web client (Vite) — open the URL it prints (usually
  `http://localhost:5173`).

Open that Vite URL in your browser, type a name, and play. Leave the terminal
running; stop it with **Ctrl+C**.

> If a browser tab shows the old version, hard-refresh (**Ctrl+Shift+R**).

---

## 3. The D1 database — what it is, when, and how often

**What it is:** D1 is Cloudflare's database. We use it to save each player's
progress (money, skills, inventory, position, logbook) so it survives a server
restart. The table layout lives in `server/schema.sql`.

**Do I need it to play?** No. The game runs fine without D1 — without it,
progress just isn't saved permanently (it lives in memory while the server is
up). So for local testing you can ignore D1 entirely.

**When do you run the schema command?** Exactly **once per database**, and only
when you want real saving (i.e. on the deployed website). You can't run it from
inside the running game console — you run it in a normal terminal, when the game
is **not** running, like this:

```bash
# one time only — sets up the tables in your real cloud database
npx wrangler login                       # opens a browser to authorize (first time only)
npx wrangler d1 execute banfieldthegame --remote --file=server/schema.sql
```

- `wrangler login` is what was failing before — it needs you to click "Allow"
  in a browser. In a Codespace it prints a link; open it, approve, come back.
- After that runs once, **you never run it again** unless we change the schema
  (I'll tell you if we do).
- `--remote` = the real cloud DB. Use `--local` instead if you ever want a
  throwaway local copy for testing.

**Is it connected?** The binding is already wired in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "banfieldthegame"
database_id = "9b591d2f-8916-472f-a004-80c3dbcb5b90"
```

So once you've run the `d1 execute` command above one time, saving works on the
deployed site automatically. Nothing to do per-session.

---

## 4. Publish the game as a website (Cloudflare)

This puts the game on a public `*.workers.dev` URL.

```bash
# one-time setup
npx wrangler login                       # if you haven't already
npx wrangler d1 execute banfieldthegame --remote --file=server/schema.sql

# deploy (run this each time you want to push a new version live)
npm run deploy
```

`npm run deploy` builds the client and uploads everything (the static web page,
the game server Worker, and the D1 binding) to Cloudflare. When it finishes it
prints your live URL, something like:

```
https://bamfield-tides.<your-subdomain>.workers.dev
```

Share that link and anyone can play. Re-run `npm run deploy` whenever you want
the live site to catch up to the latest code.

> Custom domain (e.g. banfieldthegame.com) is optional and done later in the
> Cloudflare dashboard under Workers → your worker → Triggers → Custom Domains.

---

## 5. Re-importing the map (bigger scale + Grappler Bay fix)

Some fixes (a **bigger inlet**, the **Grappler Bay east shore**, and **denser,
scattered trees**) only take effect when the map is regenerated from the OSM
data. I improved the importer; you regenerate like this:

```bash
# Bamfield — bump --width up for a larger, more realistic scale.
# 1100 makes the inlet noticeably wider than the old 700.
node tools/import-osm.mjs \
  --osm-xml <your-bamfield-export>.osm \
  --bbox 48.80,-125.225,48.858,-125.135 \
  --width 1100 --id bamfield --name "Bamfield" \
  --spawn-near "market" \
  --out shared/regions/bamfield.json

# Anacla / Pachena Bay
node tools/import-osm.mjs \
  --osm-xml <your-anacla-export>.osm \
  --bbox 48.785,-125.135,48.82,-125.072 \
  --width 700 --id anacla --name "Anacla / Pachena Bay" \
  --out shared/regions/anacla.json
```

Replace `<your-...-export>.osm` with the OSM files you downloaded. After it
runs, `npm run dev` to see the new map. If a specific bay still reads wrong, add
`--sea-seed X,Y` pointing at a tile inside that bay's water to force-flood it.

> Heads-up: bigger `--width` = more tiles = a bigger JSON and a bit more memory.
> The chunked loading we built handles it, but 1100 is a sensible ceiling for
> now.

---

## 6. The normal daily loop (cheat sheet)

```bash
git pull origin claude/happy-noether-8i15T   # get my latest
nvm use 22                                    # right Node version
npm run dev                                    # play/test locally
# ...happy with it?...
npm run deploy                                 # push it live
```

That's the whole thing. Pull, run, (optionally) deploy.
