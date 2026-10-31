import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AppModule } from '../../app.module';
import { HomeModule } from '../home.module';
import { GroupCallFacade, GroupCallState } from '../group-call-facade.service';
import { CallPresentationAction, CallPresentationControl, CallPresentationParticipants, CallPresentationProfile } from '../call-presentation.model';
import { GroupCallSurfaceComponent } from './group-call-surface.component';

const activeRoom = {
    room_id: 'room-1',
    conversation_id: 'group-1',
    membership_revision: 1,
    generation: 1,
    status: 'active' as const,
    expires_at: '2026-01-01T00:00:00Z',
    participants: [{ user_id: 'user-1', device_id: 'device-1' }, { user_id: 'user-2', device_id: 'device-2' }],
};

describe('GroupCallSurfaceComponent', () => {
    let fixture: ComponentFixture<GroupCallSurfaceComponent>;
    let component: GroupCallSurfaceComponent;
    const fullscreenElementDescriptor = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
    const exitFullscreenDescriptor = Object.getOwnPropertyDescriptor(document, 'exitFullscreen');
    const elementRequestFullscreenDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'requestFullscreen');

    const profile: CallPresentationProfile = { name: 'Project group', status: '2 participants in the group call.', isGroup: true, error: false };
    const participants: readonly CallPresentationParticipants[] = [{ id: 'user-1', name: 'Owner' }, { id: 'user-2', name: 'Member' }];
    const controls: readonly CallPresentationControl[] = [
        { id: 'microphone', label: 'Microphone input', value: 'mic-1', options: [{ id: 'mic-1', label: 'Current microphone' }], disabled: false },
        { id: 'speaker', label: 'Speaker output', value: '', options: [{ id: '', label: 'System default' }], disabled: false },
        { id: 'quality', label: 'Presentation quality', value: '720p', options: [{ id: '720p', label: '720p · balanced' }], disabled: false },
    ];
    const actions: readonly CallPresentationAction[] = [
        { id: 'mute', label: 'Mute microphone', active: false, disabled: false },
        { id: 'screen-share', label: 'Present screen', active: false, disabled: false },
    ];

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [AppModule, HomeModule],
            providers: [{provide: GroupCallFacade, useValue: {registerRemoteAudio: vi.fn(), unregisterRemoteAudio: vi.fn(), playRemoteAudio: vi.fn()}}],
        }).compileComponents();
        fixture = TestBed.createComponent(GroupCallSurfaceComponent);
        component = fixture.componentInstance;
        component.profile = profile;
        component.participants = participants;
        component.controls = controls;
        component.actions = actions;
    });

    afterEach(() => {
        if (fullscreenElementDescriptor) Object.defineProperty(document, 'fullscreenElement', fullscreenElementDescriptor);
        else Reflect.deleteProperty(document, 'fullscreenElement');
        if (exitFullscreenDescriptor) Object.defineProperty(document, 'exitFullscreen', exitFullscreenDescriptor);
        else Reflect.deleteProperty(document, 'exitFullscreen');
        if (elementRequestFullscreenDescriptor) Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', elementRequestFullscreenDescriptor);
        else Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen');
    });

    it('keeps group roster, Material device selectors, and distinct leave/end actions in the active presentation', () => {
        component.state = { ...activeState(), audioPlaybackBlocked: true };
        component.ongoing = true;
        const intents: unknown[] = [];
        component.intent.subscribe(intent => intents.push(intent));
        fixture.detectChanges();

        const surface = fixture.nativeElement as HTMLElement;
        expect(surface.querySelector('.group-call-roster')?.textContent).toContain('Participants');
        expect(surface.querySelector('.group-call-roster')?.textContent).toContain('Owner');
        expect(surface.querySelector('.group-call-roster')?.textContent).toContain('Member');
        expect(surface.querySelectorAll('.group-call-devices [role="combobox"]').length).toBe(3);
        expect(surface.querySelector('.group-call-devices .call-quality-trigger')).not.toBeNull();
        expect(surface.querySelector('.share-audio-toggle input[type="checkbox"]')?.getAttribute('aria-label')).toBe('Share audio');
        expect((surface.querySelector('.share-audio-toggle input') as HTMLInputElement).checked).toBe(false);

        const activeControls = surface.querySelector('.group-call-active-controls');
        expect(activeControls).not.toBeNull();
        expect(activeControls?.querySelectorAll('app-call-icon-actions')).toHaveLength(2);
        expect(surface.querySelector('.group-call-end-button')?.getAttribute('aria-label')).toBe('End group call for everyone');
        expect(surface.querySelector('.group-call-leave')?.textContent.trim()).toBe('Leave call');
        expect(surface.querySelector('.group-call-supplemental-actions')?.getAttribute('aria-label')).toBe('Additional group call actions');
        expect(surface.querySelector('.group-call-active-controls')?.contains(surface.querySelector('.group-call-leave'))).toBe(false);
        expect(surface.querySelector('.group-call-enable-sound')?.textContent.trim()).toBe('Enable sound');
        expect(surface.querySelector('.zwei-call-frame-collapse')?.getAttribute('aria-label')).toBe('Minimize group call');

        surface.querySelector<HTMLButtonElement>('.group-call-action-mute button')?.click();
        surface.querySelector<HTMLButtonElement>('.group-call-action-share button')?.click();
        const audioCheckbox = surface.querySelector<HTMLInputElement>('.share-audio-toggle input');
        if (audioCheckbox) {
            audioCheckbox.checked = true;
            audioCheckbox.dispatchEvent(new Event('change'));
        }
        surface.querySelector<HTMLButtonElement>('.group-call-enable-sound')?.click();
        surface.querySelector<HTMLButtonElement>('.group-call-end-button')?.click();
        surface.querySelector<HTMLButtonElement>('.group-call-leave')?.click();
        surface.querySelector<HTMLButtonElement>('.zwei-call-frame-collapse')?.click();
        expect(intents).toEqual([
            { type: 'action', actionID: 'mute' },
            { type: 'action', actionID: 'screen-share' },
            { type: 'screen-share-audio-change', enabled: true },
            { type: 'enable-sound' },
            { type: 'end' },
            { type: 'leave' },
            { type: 'collapse' },
        ]);
    });

    it('announces peer recovery while retaining the active call and leave control', () => {
        const warning = 'A participant connection failed. Leave and rejoin the group call to reconnect.';
        component.state = {...activeState(), statusLabel: warning, errorLabel: warning};
        component.profile = {...profile, status: warning, error: true};
        component.ongoing = true;
        fixture.detectChanges();
        const surface = fixture.nativeElement as HTMLElement;
        expect(surface.querySelector('[role="alert"]')?.textContent).toContain(warning);
        expect(surface.querySelector('.group-call-leave')).not.toBeNull();
        expect(surface.querySelector('.group-call-roster')).not.toBeNull();
    });

    it('shows invitation ringing only while known group members have not joined', () => {
        component.state = {...activeState(), invitationRinging: true};
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('.group-invitation-status')).not.toBeNull();
        fixture.componentRef.setInput('memberIDs', ['user-1', 'user-2', 'user-3']);
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('.group-invitation-status')).not.toBeNull();
        fixture.componentRef.setInput('memberIDs', ['user-1', 'user-2']);
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('.group-invitation-status')).toBeNull();
        expect(fixture.nativeElement.querySelector('.group-call-roster')).not.toBeNull();
    });

    it('offers accessible Stay and End choices even when minimized', () => {
        component.state = {...activeState(), soloPrompt: true};
        component.minimized = true;
        const intents: unknown[] = [];
        component.intent.subscribe(intent => intents.push(intent));
        fixture.detectChanges();
        const prompt = (fixture.nativeElement as HTMLElement).querySelector('.group-solo-prompt');
        expect(prompt?.getAttribute('aria-labelledby')).toBe('group-solo-prompt-title');
        expect(prompt?.querySelector('[role="status"]')?.textContent).toContain('No one has joined');
        const buttons = prompt?.querySelectorAll('button');
        expect(buttons?.length).toBe(2);
        buttons?.[0].click();
        buttons?.[1].click();
        expect(intents).toEqual([{type: 'stay'}, {type: 'end'}]);
    });

    it('shows a compact header copy control for a server reference and omits it for older servers', () => {
        fixture.componentRef.setInput('state', {...activeState(), supportRef: 'group-ref-1'});
        fixture.componentRef.setInput('ongoing', true);
        fixture.detectChanges();
        const copy = fixture.nativeElement.querySelector('.group-call-support app-copy-support-reference button') as HTMLButtonElement | null;
        expect(copy?.getAttribute('aria-label')).toBe('Copy support reference');
        expect(copy?.querySelector('zwei-icon svg path')?.getAttribute('d')).toBeTruthy();
        expect(copy?.textContent?.trim()).toBe('');
        expect(fixture.nativeElement.querySelector('.group-call-actions app-copy-support-reference')).toBeNull();

        fixture.componentRef.setInput('state', activeState());
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('.group-call-support app-copy-support-reference')).toBeNull();
    });

    it('keeps the compact support-reference control in the shared footer', () => {
        fixture.componentRef.setInput('state', {...activeState(), supportRef: 'group-ref-1'});
        fixture.componentRef.setInput('ongoing', true);
        fixture.detectChanges();
        const footer = fixture.nativeElement.querySelector('.zwei-call-frame-footer') as HTMLElement | null;
        const support = footer?.querySelector('.group-call-support app-copy-support-reference');
        expect(support).not.toBeNull();
    });

    it('keeps Join and room End separate before a local participant joins', () => {
        component.state = { ...activeState(), phase: 'ringing', localStream: undefined };
        component.ongoing = false;
        const intents: unknown[] = [];
        component.intent.subscribe(intent => intents.push(intent));
        fixture.detectChanges();

        const surface = fixture.nativeElement as HTMLElement;
        expect(surface.querySelector('.group-call-join')?.textContent.trim()).toBe('Join call');
        expect(surface.querySelector('.group-call-end-button-labeled')?.textContent.trim()).toBe('End call');
        expect(surface.querySelector('.group-call-active-controls')).toBeNull();
        expect(surface.querySelector('.group-call-leave')).toBeNull();
        surface.querySelector<HTMLButtonElement>('.group-call-join')?.click();
        surface.querySelector<HTMLButtonElement>('.group-call-end-button-labeled')?.click();
        expect(intents).toEqual([{ type: 'join' }, { type: 'end' }]);
    });

    it('keeps each active remote audio sink mounted while minimized and removes it on terminal state', () => {
        const remoteStream = new MediaStream();
        component.state = {...activeState(), peers: [{userID: 'user-2', deviceID: 'device-2', stream: remoteStream}]};
        component.minimized = false;
        component.ongoing = true;
        fixture.detectChanges();

        const surface = fixture.nativeElement as HTMLElement;
        const audio = surface.querySelector<HTMLAudioElement>('audio[groupRemoteAudio]');
        expect(audio).not.toBeNull();
        expect(audio?.srcObject).toBe(remoteStream);
        expect(surface.querySelectorAll('audio[groupRemoteAudio]')).toHaveLength(1);

        fixture.componentRef.setInput('minimized', true);
        fixture.detectChanges();
        expect(surface.querySelector('.group-call-panel')).toBeNull();
        expect(surface.querySelector('.group-call-active-controls')).toBeNull();
        expect(surface.querySelectorAll('audio[groupRemoteAudio]')).toHaveLength(1);
        expect(surface.querySelector<HTMLAudioElement>('audio[groupRemoteAudio]')).toBe(audio);
        expect(audio?.srcObject).toBe(remoteStream);

        fixture.componentRef.setInput('minimized', false);
        fixture.detectChanges();
        expect(surface.querySelector('.group-call-panel')).not.toBeNull();
        expect(surface.querySelector('.group-call-active-controls')).not.toBeNull();
        expect(surface.querySelectorAll('audio[groupRemoteAudio]')).toHaveLength(1);
        expect(surface.querySelector<HTMLAudioElement>('audio[groupRemoteAudio]')).toBe(audio);

        fixture.componentRef.setInput('state', {...activeState(), phase: 'ended', peers: []});
        fixture.detectChanges();
        expect(surface.querySelector('.group-call-panel')).toBeNull();
        expect(surface.querySelectorAll('audio[groupRemoteAudio]')).toHaveLength(0);
    });

    it('renders and reports when a group presentation video is ready', () => {
        component.state = { ...activeState(), presentation: new MediaStream() };
        const event = new Event('canplay');
        const intents: unknown[] = [];
        component.intent.subscribe(intent => intents.push(intent));
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('.group-call-presentation')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('.group-call-presentation-heading')?.textContent).toContain('Shared presentation');
        (fixture.nativeElement as HTMLElement).querySelector<HTMLVideoElement>('.group-presentation')?.dispatchEvent(event);
        expect(intents).toEqual([{ type: 'presentation-ready', event }]);
    });

    it('labels fullscreen entry and exit and reflects browser fullscreenchange events without touching call state', async () => {
        const state = { ...activeState(), presentation: new MediaStream() };
        Object.defineProperty(document, 'exitFullscreen', {configurable: true, value: vi.fn()});
        component.state = state;
        fixture.detectChanges();
        const surface = fixture.nativeElement as HTMLElement;
        const stage = surface.querySelector<HTMLElement>('.group-call-presentation');
        const enterFullscreen = vi.fn(async () => {
            Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: stage});
            document.dispatchEvent(new Event('fullscreenchange'));
        });
        Object.defineProperty(stage, 'requestFullscreen', {configurable: true, value: enterFullscreen});
        fixture.detectChanges();
        expect(component.fullscreenSupported).toBe(true);
        const button = surface.querySelector<HTMLButtonElement>('.group-presentation-fullscreen');
        expect(stage).not.toBeNull();
        expect(button?.getAttribute('aria-label')).toBe('Expand shared presentation');

        button?.click();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(enterFullscreen).toHaveBeenCalledOnce();
        expect(document.fullscreenElement).toBe(stage);
        expect(component.presentationFullscreen).toBe(true);
        expect(surface.querySelector('.group-presentation-fullscreen')?.getAttribute('aria-label')).toBe('Exit fullscreen');
        expect(component.state).toBe(state);

        const exitFullscreen = vi.fn(async () => {
            Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: null});
            document.dispatchEvent(new Event('fullscreenchange'));
        });
        Object.defineProperty(document, 'exitFullscreen', {configurable: true, value: exitFullscreen});
        surface.querySelector<HTMLButtonElement>('.group-presentation-fullscreen')?.click();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(exitFullscreen).toHaveBeenCalledOnce();
        expect(document.fullscreenElement).toBeNull();
        expect(component.presentationFullscreen).toBe(false);
        expect(surface.querySelector('.group-presentation-fullscreen')?.getAttribute('aria-label')).toBe('Expand shared presentation');

        exitFullscreen.mockClear();
        Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: stage});
        document.dispatchEvent(new Event('fullscreenchange'));
        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
        await fixture.whenStable();
        fixture.detectChanges();
        expect(exitFullscreen).toHaveBeenCalledOnce();
        expect(component.presentationFullscreen).toBe(false);
        Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: null});
        document.dispatchEvent(new Event('fullscreenchange'));
        expect(component.presentationFullscreen).toBe(false);
        expect(component.state).toBe(state);
    });

    it('hides fullscreen when unsupported and announces a denied request without changing call state', async () => {
        const state = { ...activeState(), presentation: new MediaStream() };
        Object.defineProperty(document, 'exitFullscreen', {configurable: true, value: undefined});
        component.state = state;
        fixture.detectChanges();
        const surface = fixture.nativeElement as HTMLElement;
        const stage = surface.querySelector<HTMLElement>('.group-call-presentation');
        expect(stage).not.toBeNull();
        expect(surface.querySelector<HTMLButtonElement>('.group-presentation-fullscreen')).toBeNull();

        fixture.destroy();
        fixture = TestBed.createComponent(GroupCallSurfaceComponent);
        component = fixture.componentInstance;
        const denialState = { ...state };
        component.state = denialState;
        Object.defineProperty(document, 'exitFullscreen', {configurable: true, value: vi.fn()});
        fixture.detectChanges();
        const denialSurface = fixture.nativeElement as HTMLElement;
        const denialStage = denialSurface.querySelector<HTMLElement>('.group-call-presentation');
        expect(denialStage).not.toBeNull();
        Object.defineProperty(denialStage, 'requestFullscreen', {configurable: true, value: vi.fn().mockRejectedValue(new Error('denied'))});
        expect(component.fullscreenSupported).toBe(true);
        const button = denialSurface.querySelector<HTMLButtonElement>('.group-presentation-fullscreen');
        expect(button).not.toBeNull();
        button?.click();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(denialSurface.querySelector('[role="status"]')?.textContent?.trim()).toBe('Fullscreen could not be opened. Your group call is still active.');
        expect(component.state).toBe(denialState);
        expect(denialState.phase).toBe('active');
    });

    it('exits the stage when its presentation component is destroyed', () => {
        const state = { ...activeState(), presentation: new MediaStream() };
        component.state = state;
        fixture.detectChanges();
        const stage = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.group-call-presentation');
        expect(stage).not.toBeNull();
        const exitFullscreen = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(document, 'exitFullscreen', {configurable: true, value: exitFullscreen});
        Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: stage});
        fixture.destroy();

        expect(exitFullscreen).toHaveBeenCalledOnce();
        expect(component.state).toBe(state);
    });
});

function activeState(): GroupCallState {
    return {
        phase: 'active',
        room: activeRoom,
        localStream: new MediaStream(),
        peers: [],
        muted: false,
        sharing: false,
        screenShareAudioEnabled: false,
        screenShareAudioActive: false,
        shareTransitioning: false,
        inputDevices: [],
        outputDevices: [],
        audioPlaybackBlocked: false,
        statusLabel: '2 participants in the group call.',
    };
}
