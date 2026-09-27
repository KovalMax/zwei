import {ZweiIconName} from '../shared/zwei-icon/zwei-icon.component';

export type GroupMemberActionID = 'make-admin' | 'make-member' | 'transfer-owner' | 'remove-member';

export interface GroupMemberAction {
    readonly id: GroupMemberActionID;
    readonly label: string;
    readonly ariaLabel: string;
    readonly icon: ZweiIconName;
}

export interface GroupMemberActionIntent {
    readonly memberUserID: string;
    readonly actionID: GroupMemberActionID;
}
