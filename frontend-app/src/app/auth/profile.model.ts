export type AlertMode = 'off' | 'sounds' | 'notifications';

export interface Profile {
    id: string;
    email: string;
    display_name: string;
    retention_period: string;
    auto_load_approved_media: boolean;
    alert_mode?: AlertMode;
}

export interface ProfileUpdate {
    display_name?: string;
    retention_period?: string;
    alert_mode?: AlertMode;
    auto_load_approved_media?: boolean;
}
