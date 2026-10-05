export interface CallPresentationProfile {
    readonly name: string;
    readonly status: string;
    readonly initials?: string;
    readonly isGroup?: boolean;
    readonly duration?: string;
    readonly error: boolean;
}

export interface CallPresentationDevice {
    readonly id: string;
    readonly label: string;
}

export interface CallPresentationParticipants {
    readonly id: string;
    readonly name: string;
}

export type CallPresentationControlID = 'microphone' | 'speaker' | 'quality';
export type CallPresentationActionID = 'mute' | 'screen-share';
export type CallPresentationActionStyle = 'square' | 'round';

export interface CallPresentationControl {
    readonly id: CallPresentationControlID;
    readonly label: string;
    readonly value: string;
    readonly options: readonly CallPresentationDevice[];
    readonly disabled: boolean;
}

export interface CallPresentationAction {
    readonly id: CallPresentationActionID;
    readonly label: string;
    readonly active: boolean;
    readonly disabled: boolean;
    readonly style?: CallPresentationActionStyle;
}

export interface CallPresentationControlChange {
    readonly id: CallPresentationControlID;
    readonly value: string;
}
