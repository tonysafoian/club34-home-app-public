# 🛡️ Enterprise Network & Surveillance Integration Guide

For properties with commercial-grade network hardware and security camera installations, Household OS provides native monitoring for FortiGate firewalls, Ruckus Wi-Fi access points, and Verkada / UniFi camera feeds.

---

## 🔒 1. FortiGate Next-Generation Firewall

Household OS monitors perimeter gateway health and bandwidth consumption:

1. Create a REST API Administrator in the FortiGate Web UI:
   * **System → Administrators → Create New → REST API Admin**.
   * Assign Read permissions to `system`, `router`, and `firewall`.
2. Configure `.env`:
   ```env
   FORTIGATE_BASE_URL=https://192.168.1.1
   FORTIGATE_API_TOKEN=your_fortigate_rest_token
   ```

### Monitored Metrics:
* **WAN Throughput**: Live upload and download bandwidth (Mbps).
* **Active Connections**: Concurrent TCP/UDP sessions.
* **Gateway Latency & Uptime**: Real-time ISP jitter and failover status.

---

## 📶 2. Ruckus Wireless (ZoneDirector / Unleashed / SmartZone)

Monitor property-wide wireless coverage across main residences, guest houses, and outdoor amenities:

```env
RUCKUS_BASE_URL=https://192.168.1.2:8443
RUCKUS_USERNAME=admin
RUCKUS_PASSWORD=your_ruckus_password
```

### Monitored Metrics:
* Connected client count by Wi-Fi SSID (IoT, Family, Guest, Staff).
* Access Point (AP) health and channel congestion.
* Client roaming and RSSI signal strength distribution.

---

## 📹 3. Surveillance Cameras (Verkada & UniFi Protect)

Household OS integrates real-time camera views into the physical security dashboard:

### Verkada Command API
```env
VERKADA_API_KEY=your_verkada_api_key
VERKADA_ORG_ID=your_organization_id
```

### UniFi Protect & RTSP Cameras
For local camera streams (UniFi Protect, Reolink, Axis):
1. Enable RTSP / WebRTC streaming in your NVR or camera settings.
2. Configure camera endpoints in `src/pages/SecurityCameras.tsx`.
3. Streams are delivered with low-latency WebSockets and H.264 video decoding.
