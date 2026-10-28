# Run SynthOS continuously from this checkout

This Linux user service runs the built fork through the same `apps/server/dist/bin.mjs` entrypoint as `gch`. It binds to `127.0.0.1:4317`, uses `~/.synthos`, and restarts after a crash. Automatic release downloads and the upstream binary service installer are disabled in this fork.

Keep this checkout, its installed dependencies, and the Node executable used to generate the unit at their current paths. Install dependencies using the repository's supported Node and package-manager versions, then build and check the local output:

```sh
node_modules/.bin/vp run --filter t3 build
node scripts/synthos-service/run.mjs --check
node scripts/synthos-service/run.mjs --print-unit
```

Review the printed unit. `--print-unit` only writes to stdout; it does not install or start a service. The following commands install the reviewed unit for your own account:

```sh
mkdir -p ~/.config/systemd/user
node scripts/synthos-service/run.mjs --print-unit > ~/.config/systemd/user/synthos-source.service
systemctl --user daemon-reload
systemctl --user enable --now synthos-source.service
systemctl --user status synthos-source.service
journalctl --user -u synthos-source.service -f
```

To keep the user service running after logout and start it at boot, enable lingering for the account with `loginctl enable-linger "$USER"` (the host may require administrator authorization). No service has been installed or started by adding these files.

Set `SYNTHOS_HOME` to an absolute path and/or `SYNTHOS_PORT` before printing the unit to select a different data directory or port. The generated unit records those settings and the current `PATH` so installed provider CLIs can be found; it does not copy API keys. Provider CLI logins use the service account. Configure any required provider credentials in the service account through normal login or an operator-managed systemd environment file.

After reviewing source changes, stop the service, rebuild, then restart it:

```sh
systemctl --user stop synthos-source.service
node_modules/.bin/vp run --filter t3 build
systemctl --user start synthos-source.service
```

Use `systemctl --user disable --now synthos-source.service` to stop and disable it. The helper can also run in the foreground with `node scripts/synthos-service/run.mjs --run`. It never downloads a runtime or updates the checkout. Localhost access is intentional; configure remote access separately after establishing the intended authentication and network policy.
