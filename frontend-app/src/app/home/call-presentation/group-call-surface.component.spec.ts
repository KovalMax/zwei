import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AppModule } from '../../app.module';
import { HomeModule } from '../home.module';
import { GroupCallState } from '../group-call-facade.service';
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
        await TestBed.configureTestingModule({ imports: [AppModule, HomeModule] }).compileComponents();
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
        expect(surface.querySelector('.group-call-enable-sound')?.textContent.trim()).toBe('Enable sound');
        expect(surface.querySelector('.group-call-collapse-button')?.getAttribute('aria-label')).toBe('Minimize group call');

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
        surface.querySelector<HTMLButtonElement>('.group-call-collapse-button')?.click();
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
