# Run the bridge in Docker

Eufy Security Viewer needs this bridge as well as the HACS integration. This guide installs the bridge on a Docker host. After it is running, return to [step 2 in the installation guide](../README.md#2-install-and-connect-the-hacs-integration).

If you use Home Assistant OS, you can run the bridge on the same machine through the [HAOS app](../README.md#1-install-the-bridge-on-home-assistant-os). Use Docker on another machine if you want to move video processing off your HA host, including a Raspberry Pi. Run the commands below on that Docker machine.

## Requirements

- Docker Engine, Git and OpenSSL on a machine that Home Assistant can reach over your LAN.
- Access from that machine to Eufy's internet services and your cameras/HomeBase.
- Enough CPU to convert live video. Raspberry Pi performance has not been verified. See [hardware compatibility](COMPATIBILITY.md).
- A dedicated Eufy account with shared access to your devices. You will enter its credentials later in the Home Assistant integration.

The container includes Node.js 24 and FFmpeg. Each bridge manages one Eufy account. Do not use this bridge with another system that starts or stops camera streams.

## 1. Download and build

These commands check out release 0.5.0 and build its Docker image locally:

```sh
git clone --branch v0.5.0 --depth 1 https://github.com/keesmod/ha-eufy-cam.git
cd ha-eufy-cam
docker build -t eufy-viewer-bridge:0.5.0 ./bridge
```

Stay in this directory for the remaining commands. The first build may take several minutes.

## 2. Create the bridge token

For a new installation, create a private environment file:

```sh
umask 077
printf 'EUFY_BRIDGE_TOKEN=%s\n' "$(openssl rand -hex 32)" > bridge.env
```

Keep `bridge.env` private. Copy the value after `EUFY_BRIDGE_TOKEN=` into your password manager; Home Assistant will ask for it during setup. It is separate from your Eufy password. When updating an existing bridge, keep its existing file and token instead of generating another one.

## 3. Start the bridge

Replace `YOUR_LAN_IP` with this Docker machine's LAN address, such as `192.168.1.10`:

```sh
docker run -d --name eufy-viewer-bridge \
  --restart unless-stopped \
  --env-file bridge.env \
  -p YOUR_LAN_IP:8080:8080 \
  -v eufy-viewer-data:/data \
  eufy-viewer-bridge:0.5.0
```

Port 8080 on that address must be free. Home Assistant connects to `http://YOUR_LAN_IP:8080`. Use the Docker host's LAN address even if Home Assistant also runs in Docker; `localhost` inside HA points to HA's own container.

Allow Home Assistant to reach the published port. Keep it on a trusted LAN or protect it with a TLS reverse proxy; plain HTTP exposes the token and login credentials on an untrusted network. Do not forward this port from the internet. Your browser connects through Home Assistant and does not need direct access to the bridge.

Some device/network combinations may need Docker host networking for Eufy's local P2P connection. If account login works but the HomeBase cannot connect, check the bridge logs and the host's local network/firewall before changing networking. With host networking, Docker port mappings no longer restrict the listener, so review the bind address and firewall too.

## 4. Check startup and connect Home Assistant

```sh
docker ps --filter name=eufy-viewer-bridge
docker logs --tail 50 eufy-viewer-bridge
```

The container should remain running. A restarting container needs attention; check its logs, including whether the token has at least 32 characters. The bridge has no setup web page, and cameras will not appear until you complete Eufy login through Home Assistant.

Return to [step 2: install and connect the HACS integration](../README.md#2-install-and-connect-the-hacs-integration). Use `http://YOUR_LAN_IP:8080` and the token from `bridge.env`.

## Keep the bridge data

The named volume `eufy-viewer-data` holds the bridge's identity, Eufy credentials and session under `/data`. Keep this volume and `bridge.env` when recreating or updating the container. Back them up privately. An empty volume creates a different bridge identity, which the existing HA integration will not accept as the same bridge.

Never attach the data volume or environment file to a support report.

## Update the Docker bridge

These steps update an older Docker installation to 0.5.0. Run them from your existing checkout and keep the original `bridge.env`. If you used a different container name, volume name, image tag or port mapping, use those values instead of the examples below.

1. Close all live viewers and recording dialogs.
2. Download and build the new release while the old container is still available:

   ```sh
   git fetch origin tag v0.5.0
   git checkout v0.5.0
   docker build -t eufy-viewer-bridge:0.5.0 ./bridge
   ```

3. Stop the bridge, then back up its named volume and `bridge.env` using your Docker host's backup tools:

   ```sh
   docker stop eufy-viewer-bridge
   ```

4. Once the backup is complete, remove the old container. This command keeps the named data volume:

   ```sh
   docker rm eufy-viewer-bridge
   ```

5. Run the command in [step 3](#3-start-the-bridge) with your original token file, volume and LAN address. Check startup as described above.
6. [Update the HACS integration and card resource](../README.md#upgrading) to the matching release.

If the replacement fails, stop and remove that container and recreate the previous image with the same settings. Keep the previous image and private backup until you have verified the update.
