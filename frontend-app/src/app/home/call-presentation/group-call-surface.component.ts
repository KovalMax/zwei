import {ChangeDetectionStrategy, Component, EventEmitter, Input, Output} from '@angular/core';
import {GroupCallPeer, GroupCallState} from '../group-call-facade.service';
import {CallPresentationAction, CallPresentationActionID, CallPresentationControl, CallPresentationControlChange, CallPresentationParticipants, CallPresentationProfile} from '../call-presentation.model';

export type GroupCallSurfaceIntent =
    | {readonly type: 'collapse'}
    | {readonly type: 'join'}
    | {readonly type: 'enable-sound'}
    | {readonly type: 'action'; readonly actionID: CallPresentationActionID}
    | {readonly type: 'control-change'; readonly change: CallPresentationControlChange}
    | {readonly type: 'screen-share-audio-change'; readonly enabled: boolean}
    | {readonly type: 'leave'}
    | {readonly type: 'end'}
    | {readonly type: 'presentation-ready'; readonly event: Event};

@Component({
    selector: 'app-group-call-surface',
    standalone: false,
    templateUrl: './group-call-surface.component.html',
    styleUrls: ['./group-call-surface.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupCallSurfaceComponent {
    @Input({required: true}) public state?: GroupCallState;
    @Input() public minimized = false;
    @Input() public ongoing = false;
    @Input() public profile?: CallPresentationProfile;
    @Input() public participants: readonly CallPresentationParticipants[] = [];
    @Input() public controls: readonly CallPresentationControl[] = [];
    @Input() public actions: readonly CallPresentationAction[] = [];
    @Input() public panelClass = '';
    @Output() public readonly intent = new EventEmitter<GroupCallSurfaceIntent>();

    public trackPeer(_index: number, peer: GroupCallPeer): string { return `${peer.userID}:${peer.deviceID}`; }
    public emit(intent: GroupCallSurfaceIntent): void { this.intent.emit(intent); }
}
