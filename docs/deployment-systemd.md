# Deployment as Systemd service 

You can also install Cloudrive as (Linux) system service. Most distributions
use Systemd as main init system. You should **not** run Cloudrive with root privileges!

**Preparation**

```bash
# Create a target folder for Cloudrive
mkdir -p /opt/cloudrive
cd /opt/cloudrive

# Download and extract a prebuild
curl -sL https://github.com/psi-4ward/cloudrive/releases/download/1.1.0-beta/cloudrive-1.1.0-beta.tar.gz | tar xz --strip 1

# Install dependencies
npm install --production

# Add a user cloudrive
sudo useradd --system cloudrive
 
# Make cloudrive owner of /opt/cloudrive
sudo chown -R cloudrive:cloudrive /opt/cloudrive 
```

**Systemd unit file**

Grab the [cloudrive.service](https://github.com/psi-4ward/cloudrive/blob/master/docs/cloudrive.service)
sample file, put it in `/etc/systemd/system/` and adjust to your needs.

```bash
cd /etc/systemd/system
sudo wget https://raw.githubusercontent.com/psi-4ward/cloudrive/master/docs/cloudrive.service

# Start the service
sudo systemctl start cloudrive

# Show the status
sudo systemctl status cloudrive

# Enable autostart on boot
sudo systemctl enable cloudrive
```
