# Virtual Office

A pixel-hotel style virtual office that runs in the browser. Real people open the same link, set up their character, and see, hear and chat with each other in real time.

## What you can do

- **Set up your character** on your first visit: name, role, skin tone, hair, outfit and extras. Your browser remembers it.
- **Talk with live voice:** unmute and people near you hear you. Voices get quieter with distance and fade out about 10 tiles away.
- **See everyone live:** where people walk and sit, their status, emotes, what they're eating or drinking, and who's talking.
- **Chat and whisper:** messages to the whole room, or a private whisper to one person (`/w Name hi`).
- **Soundproof meeting room:** inside the Harbour room, only people inside hear your voice and get your chat messages. Everyone else sees `· · ·`.
- **Lock a room:** click **🔒 Lock room** in the top-left panel and choose a passcode. People who join later need it.
- **Do things together:** emoji reactions, 20 dances (invite someone to dance with you), slaps with a trout, treating everyone to coffee or pizza, and touching the tree, presents, corgi, plants, lamp, whiteboard, bell and laptops.
- **Shared music:** the office radio and YouTube / YouTube Music links play for everyone in the room. Songs from your own computer only play for you.
- **Rooms:** add `?room=yourteam` to the link to get a separate office. Use the **🔗 Copy invite link** button.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole office (one page) |
| `server.js` | Serves the page and runs the real-time rooms |
| `hub.js` | Room logic: who's in which room, passcodes, relaying updates and voice call setup |
| `package.json` | Tells Node.js what to install and how to start |
| `render.yaml` | One-click setup for Render's free hosting |

## Put it online (free, about 5 minutes)

GitHub Pages can only host files, and multiplayer needs a small server. Render can run that server for free straight from this repository.

1. Push this repository to GitHub (public or private).
2. Sign in at [render.com](https://render.com) with your GitHub account.
3. Click **New → Blueprint**, pick this repository, and click **Apply**. Render reads `render.yaml`, installs everything and starts the server.
4. When it says **Live**, open the address it gives you, like `https://virtual-office-xxxx.onrender.com`. That's your multiplayer office. Share it, or add `?room=yourteam`.

**Free plan limits:** Render puts a free service to sleep after 15 minutes with no visitors. The next visitor waits about a minute while it wakes up. While people are in the office, the page sends a small keep-alive message every few minutes so it stays awake.

## Room passcodes

There are two ways to lock a room:

- **From inside the office:** click **🔒 Lock room** in the top-left panel and choose a passcode (3+ characters). Everyone already inside stays in and can reconnect without it. Anyone inside can click **🔓 Unlock room**. These passcodes are kept in the server's memory, so **they reset when the server restarts or falls asleep** on Render's free plan.
- **Permanent passcodes, set on the server:** in Render, open your service → **Environment** → **Add Environment Variable**, then save. The server restarts with the new setting.

| Variable | Example | What it does |
|---|---|---|
| `OFFICE_PASSWORD` | `blue-tiger-42` | One passcode for every room |
| `ROOM_PASSWORDS` | `{"sjp":"blue-tiger-42","leads":"orange-fox"}` | Passcodes for specific rooms. Wins over `OFFICE_PASSWORD`. |

People type the passcode once, and their browser remembers it. After 5 wrong tries the connection is closed, and after 10 wrong tries from the same network, that network has to wait 10 minutes.

## Live voice

- **How it works:** voice goes directly between people's browsers (WebRTC). The server only helps them find each other; it never carries or records audio.
- **Who hears you:** your browser only sends your voice to people within earshot (about 10 tiles) and on the same side of the meeting room glass.
- **Controls:** **M** or the mic button mutes you. **Speaker off** silences everyone for you. The volume slider sets how loud people are.
- **Corporate networks:** by default it uses Google's free STUN servers, which work on most home and office networks. Some strict company networks block direct connections; there, voice won't connect but everything else still works. To fix that, add a TURN server in Render's **Environment** settings:

  `ICE_SERVERS` = `[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"user","credential":"pass"}]`

- **Size:** voice works best with up to about 20 people in a room. Each person connects directly to everyone else.

### GitHub Pages copy

There are no made-up coworkers anywhere. Everyone in the office is a real person.

- **The Render address** (`https://virtual-office-xxxx.onrender.com`) connects on its own. This is the easiest link to share.
- **The GitHub Pages address** starts out not connected, with just you in the office. Click **🔌 Connect to server** in the top-left panel and paste your Render address. Your browser remembers it.
- **To skip that step for everyone,** share a link with the server in it, like `https://<you>.github.io/<repo>/?server=virtual-office-xxxx.onrender.com`. The **🔗 Copy invite link** button builds this for you.
- **To build the address into the page itself,** edit this line near the top of `index.html`:

  ```js
  window.VO_SERVER = 'https://virtual-office-xxxx.onrender.com';
  ```

## Run it on your own computer

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000 in two browser windows to see two people in the office. Use headphones when testing voice on one computer.

## Good to know

- **It's not end-to-end encrypted.** Chat goes through your server. Voice is encrypted between browsers, as all WebRTC audio is. Don't use it for passwords, customer data or anything confidential.
- **Meeting room privacy:** the server only sends meeting-room chat to people inside. Each speaker's browser stops sending voice to people outside.
- **Room size:** a room holds up to 40 people. Set `MAX_PER_ROOM` to change it.

## Keyboard shortcuts

| Key | Action |
|---|---|
| M | Mute / unmute mic |
| 1–4 | Dance, sing, guitar, sleep |
| P | Pantry |
| H | Hide / show the side panel |
| Esc | Close menus |

## Credits

Built with [Three.js](https://threejs.org/) and [ws](https://github.com/websockets/ws) (both MIT license). Fonts: Nunito and Pixelify Sans from Google Fonts (SIL Open Font License). All characters, art and sounds are original and generated in code. Inspired by classic isometric pixel hotel games; not affiliated with any of them.
