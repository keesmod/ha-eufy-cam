export type Recognition = "known" | "unknown" | "unidentified" | "not_applicable";
export interface Notification {
  id: string; serial: string; event_type: string; received_at: string;
  source: "device" | "push"; person_name: string | null; recognition: Recognition;
  occurred_at: string | null; eufy_event_type?: number;
}
