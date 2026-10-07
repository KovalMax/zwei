import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AppModule } from '../../app.module';
import { HomeModule } from '../home.module';
import { CallState } from '../call-facade.service';
import { DirectCallSurfaceComponent } from './direct-call-surface.component';

describe('DirectCallSurfaceComponent', () => {
    let fixture: ComponentFixture<DirectCallSurfaceComponent>;
    let component: DirectCallSurfaceComponent;

    beforeEach(async () => {
        await TestBed.configureTestingModule({ imports: [AppModule, HomeModule] }).compileComponents();
        fixture = TestBed.createComponent(DirectCallSurfaceComponent);
        component = fixture.componentInstance;
    });

    it('scopes theme-specific notification styling to incoming calls', () => {
        const incomingState: CallState = {
            phase: 'incoming', role: 'recipient', callID: 'call-1', conversationID: 'conversation-1', peerID: 'peer-1',
            muted: false, screenShareQuality: '720p', screenShareAudioEnabled: false, screenShareAudioActive: false,
            screenShareTransition: false, statusLabel: 'Incoming audio call.',
        };
        fixture.componentRef.setInput('state', incomingState);
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('.call-card.call-card-incoming')).not.toBeNull();

        fixture.componentRef.setInput('state', {...incomingState, phase: 'active'});
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('.call-card-incoming')).toBeNull();
    });

    it('keeps unsupported screen-share audio visible, disabled, and accessibly explained', () => {
        component.state = {
            phase: 'active', role: 'caller', callID: 'call-1', conversationID: 'conversation-1', peerID: 'peer-1',
            muted: false, screenShareQuality: '720p', screenShareAudioEnabled: false, screenShareAudioActive: false,
            screenShareTransition: false, statusLabel: 'Audio call connected.',
        };
        component.controls = [{ id: 'quality', label: 'Screen share quality', value: '720p', options: [{ id: '720p', label: '720p · balanced' }], disabled: false }];
        component.actions = [
            { id: 'mute', label: 'Mute microphone', active: false, disabled: false },
            { id: 'screen-share', label: 'Share screen', active: false, disabled: true },
        ];
        component.screenShareSupported = false;
        fixture.detectChanges();

        const checkbox = fixture.nativeElement.querySelector('.share-audio-toggle input') as HTMLInputElement;
        expect(checkbox).not.toBeNull();
        expect(checkbox.disabled).toBe(true);
        expect(checkbox.getAttribute('aria-label')).toBe('Share audio');
        expect(checkbox.getAttribute('aria-describedby')).toContain('call-share-audio-unavailable-status');
        expect(checkbox.getAttribute('aria-description')).toContain('unavailable');
        expect(fixture.nativeElement.querySelector('.share-audio-unavailable-reason')?.textContent).toContain('screen sharing is not supported');
        expect(fixture.nativeElement.querySelector('.call-quality-audio-row')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('.call-actions').textContent).not.toContain('End call');
    });

    it('renders quality selection and audio opt-in together only for the direct call surface', () => {
        component.state = {
            phase: 'active', role: 'caller', callID: 'call-1', conversationID: 'conversation-1', peerID: 'peer-1',
            muted: false, screenShareQuality: '720p', screenShareAudioEnabled: false, screenShareAudioActive: false,
            screenShareTransition: false, statusLabel: 'Audio call connected.',
        };
        component.controls = [
            { id: 'microphone', label: 'Microphone input', value: 'mic', options: [{ id: 'mic', label: 'Mic' }], disabled: false },
            { id: 'speaker', label: 'Speaker output', value: '', options: [{ id: '', label: 'System default' }], disabled: false },
            { id: 'quality', label: 'Screen share quality', value: '720p', options: [{ id: '720p', label: '720p' }], disabled: false },
        ];
        component.screenShareSupported = true;
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('.call-quality-audio-row-feature .share-audio-toggle')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('.call-quality-audio-row-feature .call-quality-trigger')).not.toBeNull();
    });

    it('emits existing typed action/end/collapse intents from the direct call controls', () => {
        component.state = {
            phase: 'active', role: 'caller', callID: 'call-1', conversationID: 'conversation-1', peerID: 'peer-1',
            muted: false, screenShareQuality: '720p', screenShareAudioEnabled: false, screenShareAudioActive: false,
            screenShareTransition: false, statusLabel: 'Audio call connected.',
        };
        component.profile = { name: 'Peer', status: 'Audio call connected.', error: false };
        component.actions = [{ id: 'mute', label: 'Mute microphone', active: false, disabled: false }, { id: 'screen-share', label: 'Share screen', active: false, disabled: false }];
        const intents: unknown[] = [];
        component.intent.subscribe(intent => intents.push(intent));
        fixture.detectChanges();

        fixture.nativeElement.querySelector('.direct-call-control-row [aria-label="Mute microphone"]').click();
        fixture.nativeElement.querySelector('.direct-call-end-button').click();
        fixture.nativeElement.querySelector('.call-direct-collapse-button').click();

        expect(intents).toEqual([
            { type: 'action', actionID: 'mute' },
            { type: 'end' },
            { type: 'collapse' },
        ]);
    });
});
