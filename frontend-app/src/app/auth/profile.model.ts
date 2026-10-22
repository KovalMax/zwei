export type AlertMode = 'off' | 'sounds' | 'notifications';

export interface Profile {
    id: string;
    email: string;
    display_name: string;
    retention_period: string;
    alert_mode?: AlertMode;
}

export interface ProfileUpdate {
    alert_mode?: AlertMode;
}
