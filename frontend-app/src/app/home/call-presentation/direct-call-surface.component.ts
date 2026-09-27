import {ChangeDetectionStrategy, Component, ElementRef, EventEmitter, HostListener, Input, Output, ViewChild} from '@angular/core';
import {CallState} from '../call-facade.service';
import {CallPresentationAction, CallPresentationActionID, CallPresentationControl, CallPresentationControlChange, CallPresentationProfile} from '../call-presentation.model';

export type DirectCallSurfaceIntent =
    | {readonly type: 'accept'}
    | {readonly type: 'decline'}
    | {readonly type: 'cancel'}
    | {readonly type: 'enable-sound'}
    | {readonly type: 'end'}
    | {readonly type: 'collapse'}
    | {readonly type: 'action'; readonly actionID: CallPresentationActionID}
    | {readonly type: 'control-change'; readonly change: CallPresentationControlChange}
    | {readonly type: 'remote-audio-ready'; readonly event: Event}
    | {readonly type: 'remote-screen-ready'; readonly event: Event}
    | {readonly type: 'screen-share-audio-change'; readonly enabled: boolean};

@Component({
    selector: 'app-direct-call-surface',
    standalone: false,
    templateUrl: './direct-call-surface.component.html',
    styleUrls: ['./direct-call-surface.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DirectCallSurfaceComponent {
    @Input({required: true}) public state?: CallState;
    @Input() public profile?: CallPresentationProfile;
    @Input() public controls: readonly CallPresentationControl[] = [];
    @Input() public actions: readonly CallPresentationAction[] = [];
    @Input() public panelClass = '';
    @Input() public displayName = 'Audio call';
    @Input() public outputSelectionSupported = false;
    @Input() public screenShareSupported = false;
    @Input() public full = false;
    @Input() public minimized = false;
    @Output() public readonly intent = new EventEmitter<DirectCallSurfaceIntent>();

    public screenShareFullscreen = false;
    @ViewChild('screenStage') private screenStage?: ElementRef<HTMLElement>;

    public isOngoing(state: CallState): boolean { return state.phase === 'connecting' || state.phase === 'active'; }

    public emit(intent: DirectCallSurfaceIntent): void { this.intent.emit(intent); }

    public async toggleScreenShareFullscreen(): Promise<void> {
        const stage = this.screenStage?.nativeElement;
        if (!stage) return;
        try {
            if (document.fullscreenElement === stage) await document.exitFullscreen();
            else if (typeof stage.requestFullscreen === 'function') await stage.requestFullscreen();
        } catch {
            this.screenShareFullscreen = false;
            return;
        }
        this.screenShareFullscreen = document.fullscreenElement === stage;
    }

    @HostListener('document:fullscreenchange')
    public onFullscreenChange(): void {
        this.screenShareFullscreen = document.fullscreenElement === this.screenStage?.nativeElement;
    }
}
