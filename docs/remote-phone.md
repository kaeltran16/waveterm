# Answer Arc from your phone

Remote mode puts what waits on you (an agent's question, a lead's approval, a held or blocked run)
on an installed iPhone web app, and lets you answer agent questions from it. It runs only while you
turn it on: off means the tunnel and the phone listener are both stopped. Design:
`docs/superpowers/specs/2026-10-27-answer-arc-from-phone-design.md`.

The phone reaches Arc through a Cloudflare named tunnel behind Cloudflare Access. Arc never holds a
Cloudflare API token; it holds only the tunnel token, in its secret store.

## Set up

1. **Install cloudflared** on the PC: `winget install --id Cloudflare.cloudflared`.
2. **Create a named tunnel** in the Cloudflare dashboard (Zero Trust, Networks, Tunnels). Add a
   public hostname on your own domain (for example `arc.example.com`) pointing at
   `http://localhost:47821` (the default port; use your own if you pass `--port` below). Copy the
   tunnel token the dashboard shows.
3. **Create an Access application** (Zero Trust, Access, Applications, self-hosted) for that
   hostname, with one policy that allows only your email, by one-time PIN or Google. Note the team
   name (the part before `.cloudflareaccess.com`) and the application's AUD tag (on the
   application's overview).
4. **Give Arc the details.** The token is read from stdin, never a flag, so it stays out of the
   process list and your shell history:

   ```
   wsh remote setup --team <team> --aud <aud-tag> --email <you@example.com> --hostname arc.example.com [--port N]
   ```

   Type the token at the `Tunnel token:` prompt, or pipe it in. Setup prints the status; a re-setup
   keeps the stored phone subscription.
5. **Turn it on:** `wsh remote on`. `wsh remote status` shows whether the tunnel is `up`, and
   `wsh remote off` turns it off. The cockpit shows the same state.
6. **On the iPhone**, open `https://arc.example.com` in Safari and log in. Share, Add to Home
   Screen. Open Arc from the new home-screen icon (push only works from the installed app), and tap
   **Turn on notifications**.

`wsh remote status` reads, for example:

```
Remote mode: on
Address: https://arc.example.com
Local port: 47821
Tunnel: up
Phone: subscribed (1)
Setup: complete
```

If it prints `cloudflared not found`, install it as in step 1.

## Check the login on a real iPhone

The home-screen app keeps its own cookies apart from Safari, and the Access login redirects to the
team's cloudflareaccess.com address, which may open outside the installed app and never bring the
login back. Check this once, as the first use of the finished feature:

1. With remote mode on, open the installed app from the home screen and log in from inside it.
2. Have an agent ask a question and wait for the push on the phone.
3. Open the app from that push.
4. Answer the question, and see the agent continue at the desk.

A failed login looks like one of these:

- the login page opens in Safari instead of inside the installed app, and the app stays on the login;
- the app loops back to the login after you finish it.

If the login cannot be completed inside the installed app, report what you saw instead of
loosening anything. The Access check on every request and the owner-email lock stay as they are;
nothing is bypassed to make the login work.

## Turning it off

`wsh remote off`, the cockpit's remote switch, or **Turn off remote mode** at the foot of the phone
page. The page then goes offline and the PC may sleep again.
