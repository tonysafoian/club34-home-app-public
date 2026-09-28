export type NetworkTab = 'overview' | 'devices' | 'wifi-networks' | 'traffic' | 'top-sites' | 'security' | 'interfaces' | 'dns-dhcp';

export interface FortiInterface {
  name: string;
  ip: string;
  mask: string;
  type: string;
  vlanid: number;
  status: string;
  speed: number;
  description: string;
  link: boolean;
  rx_bytes: number | null;
  tx_bytes: number | null;
  rx_packets: number | null;
  tx_packets: number | null;
}

export interface InterfacesResponse {
  interfaces: FortiInterface[];
}

export interface HaPeer {
  hostname?: string;
  role?: string;
  priority?: number;
  serial_no?: string;
}

export interface HaStatusResponse {
  ha: boolean;
  peers: HaPeer[];
  error?: string;
}

export interface SystemHealth {
  cpu_usage: number | null;
  memory_usage: number | null;
  active_sessions: number | null;
}

export interface SystemStatus {
  uptime: number | null;
  firmware_version: string | null;
  hostname: string | null;
  serial_number: string | null;
}

export interface ConnectionMethod {
  method: 'wired' | 'wifi' | 'unknown';
  ssid: string | null;
  source: 'ruckus_live' | 'ruckus_recent' | 'heuristic' | 'subnet' | 'unknown';
  confidence: 'confirmed' | 'recent' | 'inferred' | 'unknown';
  ssid_certain: boolean;
}

export interface ConnectedDevice {
  hostname: string | null;
  original_hostname?: string | null;
  ip: string | null;
  mac: string | null;
  interface: string | null;
  last_seen: number | null;
  os_type: string | null;
  hardware_vendor: string | null;
  device_type: string | null;
  tx_bytes: number | null;
  rx_bytes: number | null;
  category?: string;
  subcategory?: string;
  vendor?: string;
  is_overridden?: boolean;
  is_random?: boolean;
  needs_label?: boolean;
  owner_missing?: boolean;
  owner?: string | null;
  connection?: ConnectionMethod;
}

export interface CategoryVendor {
  vendor: string;
  total: number;
  active: number;
}

export interface CategorySubcategory {
  subcategory: string;
  total: number;
  active: number;
  vendors: CategoryVendor[];
}

export interface CategoryTreeNode {
  category: string;
  total: number;
  active: number;
  subcategories: CategorySubcategory[];
}

export interface ConnectionCacheFreshness {
  oldest: number | null;
  newest: number | null;
  count: number;
}

export interface DevicesResponse {
  devices: ConnectedDevice[];
  total: number;
  categoryTree?: CategoryTreeNode[];
  ruckus_feed_healthy?: boolean;
  connection_cache?: ConnectionCacheFreshness;
}

export interface RefreshConnectionsResponse {
  ok: boolean;
  updated: number;
  connection_cache?: ConnectionCacheFreshness;
}

export interface SecurityThreat {
  severity: string;
  src_ip: string | null;
  dst_ip: string | null;
  attack: string;
  action: string | null;
  timestamp: string | null;
  protocol?: string | null;
  service?: string | null;
  src_country?: string | null;
  dst_country?: string | null;
  sent_bytes?: number | null;
  rcvd_bytes?: number | null;
  policy_id?: string | null;
  reference?: string | null;
}

export interface ThreatsResponse {
  threats: SecurityThreat[];
  total: number;
}

export interface VpnSession {
  type: 'ssl' | 'ipsec';
  user: string;
  src_ip: string | null;
  connected_at: string | null;
  duration_seconds: number | null;
  vpn_ip: string | null;
  status?: string;
}

export interface VpnResponse {
  sessions: VpnSession[];
  ssl_count: number;
  ipsec_count: number;
  total: number;
}

export interface TrafficTalker {
  ip: string;
  bytes: number;
  tx_bytes: number;
  rx_bytes: number;
  hostname?: string | null;
  mac?: string | null;
  /** Admin-set category override (device_overrides.custom_category), if any. */
  category?: string | null;
}

export interface InterfaceBandwidth {
  name: string;
  rx_bytes: number;
  tx_bytes: number;
  link: boolean;
}

export interface WanThroughput {
  rx_bytes: number | null;
  tx_bytes: number | null;
  history: { t: number; rx: number; tx: number }[];
}

export interface TrafficResponse {
  top_talkers: TrafficTalker[];
  interface_bandwidth: InterfaceBandwidth[];
  wan_throughput?: WanThroughput;
}

export interface TopSite {
  domain: string;
  category: string | null;
  hits: number;
  bytes: number;
}

export interface TopSitesResponse {
  sites: TopSite[];
  total: number;
}

export interface FortiViewSensorStatus {
  present: boolean;
  has_data: boolean;
}

export interface FortiViewStatusResponse {
  cache_ready: boolean;
  top_talkers: FortiViewSensorStatus;
  top_sites: FortiViewSensorStatus;
  all_present: boolean;
}

export interface DeviceDestination {
  domain: string;
  category: string | null;
  hits: number;
  bytes: number;
  tx_bytes: number;
  rx_bytes: number;
}

export interface DeviceTrafficResponse {
  srcip: string;
  /** Friendly device name (override > label > FortiGate hostname > observed hostname), null → show raw IP. */
  hostname: string | null;
  mac: string | null;
  category: string | null;
  total_tx_bytes: number;
  total_rx_bytes: number;
  total_bytes: number;
  destinations: DeviceDestination[];
  traffic_log: { timestamp: string | null; dst: string | null; bytes: number; tx_bytes: number; rx_bytes: number }[];
}

export interface SpeedTestResult {
  id: string;
  download_mbps: number;
  upload_mbps: number;
  latency_ms: number;
  jitter_ms: number | null;
  server_name: string | null;
  tested_at: string;
  provider: string;
}

export interface DnsQuery {
  domain: string;
  query_type: string | null;
  action: string;
  category: string | null;
  src_ip: string | null;
  timestamp: string | null;
}

export interface BlockedDomain {
  domain: string;
  category: string | null;
  count: number;
  latest: string | null;
}

export interface TopDomain {
  domain: string;
  count: number;
}

export interface DhcpLease {
  hostname: string | null;
  ip: string | null;
  mac: string | null;
  interface: string | null;
  lease_start: string | null;
  lease_end: string | null;
  status: string | null;
}

export interface DnsDhcpResponse {
  dns_queries: DnsQuery[];
  top_domains: TopDomain[];
  blocked_domains: BlockedDomain[];
  total_blocked: number;
  dhcp_leases: DhcpLease[];
  dns_available: boolean;
  webfilter_available: boolean;
  dhcp_available: boolean;
}

export interface NetworkHealthSnapshot {
  id: string;
  captured_at: string;
  cpu_usage: string | null;
  memory_usage: string | null;
  active_sessions: number | null;
  wan_status: string | null;
  wan_link: boolean | null;
  threat_count: number | null;
}

export interface NetworkAlert {
  id: string;
  created_at: string;
  category: string;
  event_type: string;
  severity: string;
  summary: string;
  detail: Record<string, unknown>;
  actor_name: string | null;
}

export interface WanHistoryPoint {
  ts: number;
  rx: number;
  tx: number;
  rx_mbps: number;
  tx_mbps: number;
}

export interface WanHistoryResponse {
  points: WanHistoryPoint[];
  windowMinutes: number;
}

export type HealthScore = 'green' | 'yellow' | 'red';

export type SortKey = keyof ConnectedDevice;

export interface SdwanMember {
  seq: number;
  interface: string;
  label: string;
  status: "alive" | "dead" | "unknown";
  latency_ms: number | null;
  jitter_ms: number | null;
  packet_loss_pct: number | null;
  sla_met: boolean;
  gateway: string | null;
}

export interface SdwanHealthResponse {
  zone: string;
  health_check_name?: string | null;
  mode: string;
  members: SdwanMember[];
  sla_latency_threshold_ms: number;
  sla_packet_loss_threshold_pct: number;
}

export interface WanLinkStats {
  rx_bytes: number | null;
  tx_bytes: number | null;
  rx_gb: number | null;
  tx_gb: number | null;
  link: boolean | null;
  wan_status: string;
  wan_speed?: number | null;
}

export interface DualWanStatsResponse extends WanLinkStats {
  source: string;
  wan1?: WanLinkStats | null;
  wan2?: WanLinkStats | null;
}
