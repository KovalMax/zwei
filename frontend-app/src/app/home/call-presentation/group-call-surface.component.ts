import {ChangeDetectionStrategy, Component, ElementRef, EventEmitter, HostListener, Input, OnDestroy, Output, ViewChild} from '@angular/core';
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
export class GroupCallSurfaceComponent implements OnDestroy {
    @Input({required: true}) public state?: GroupCallState;
    @Input() public minimized = false;
    @Input() public ongoing = false;
    @Input() public profile?: CallPresentationProfile;
    @Input() public participants: readonly CallPresentationParticipants[] = [];
    @Input() public controls: readonly CallPresentationControl[] = [];
    @Input() public actions: readonly CallPresentationAction[] = [];
    @Input() public panelClass = '';
    @Output() public readonly intent = new EventEmitter<GroupCallSurfaceIntent>();

    public presentationFullscreen = false;
    public fullscreenStatus = '';
    @ViewChild('presentationStage') private presentationStage?: ElementRef<HTMLElement>;

    public get fullscreenSupported(): boolean {
        return typeof document.createElement('section').requestFullscreen === 'function'
            && typeof document.exitFullscreen === 'function';
    }

    public async togglePresentationFullscreen(): Promise<void> {
        const stage = this.presentationStage?.nativeElement;
        if (!stage || !this.fullscreenSupported) return;

        this.fullscreenStatus = '';
        try {
            if (document.fullscreenElement === stage) await document.exitFullscreen();
            else await stage.requestFullscreen();
            this.syncFullscreenState();
        } catch {
            this.syncFullscreenState();
            this.fullscreenStatus = document.fullscreenElement === stage
                ? 'Could not exit fullscreen. Use Escape or your browser controls to exit.'
                : 'Fullscreen could not be opened. Your group call is still active.';
        }
    }

    @HostListener('document:fullscreenchange')
    public onFullscreenChange(): void {
        this.syncFullscreenState();
        if (this.presentationFullscreen) this.fullscreenStatus = '';
    }

    @HostListener('document:keydown', ['$event'])
    public async onDocumentKeydown(event: KeyboardEvent): Promise<void> {
        if (event.key !== 'Escape' || document.fullscreenElement !== this.presentationStage?.nativeElement) return;
        event.preventDefault();
        try {
            await document.exitFullscreen();
            this.syncFullscreenState();
        } catch {
            this.syncFullscreenState();
            this.fullscreenStatus = 'Could not exit fullscreen. Use your browser controls to exit.';
        }
    }

    public ngOnDestroy(): void {
        if (document.fullscreenElement === this.presentationStage?.nativeElement) void document.exitFullscreen().catch(() => undefined);
    }

    private syncFullscreenState(): void {
        this.presentationFullscreen = document.fullscreenElement === this.presentationStage?.nativeElement;
    }

    public trackPeer(_index: number, peer: GroupCallPeer): string { return `${peer.userID}:${peer.deviceID}`; }
    public emit(intent: GroupCallSurfaceIntent): void { this.intent.emit(intent); }
}
