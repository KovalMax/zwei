import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AppModule } from '../../app.module';
import { HomeModule } from '../home.module';
import { CallDeviceControlsComponent } from './call-device-controls.component';

describe('CallDeviceControlsComponent', () => {
    let fixture: ComponentFixture<CallDeviceControlsComponent>;
    let component: CallDeviceControlsComponent;

    beforeEach(async () => {
        await TestBed.configureTestingModule({ imports: [AppModule, HomeModule] }).compileComponents();
        fixture = TestBed.createComponent(CallDeviceControlsComponent);
        component = fixture.componentInstance;
    });

    it('emits only typed selectable device intent', () => {
        const controlChange = vi.fn().mockName('controlChange');
        component.controls = [{ id: 'microphone', label: 'Microphone input', value: 'mic-1', options: [{ id: 'mic-1', label: 'Studio microphone' }], disabled: false }];
        component.controlChange.subscribe(controlChange);
        fixture.detectChanges();

        component.select('microphone', 'unknown');
        component.select('microphone', 'mic-1');

        expect(controlChange).toHaveBeenCalledTimes(1);

        expect(controlChange).toHaveBeenCalledWith({ id: 'microphone', value: 'mic-1' });
    });

    it('tracks frequently refreshed controls and device options by stable IDs', () => {
        const microphone = { id: 'microphone', label: 'Microphone input', value: 'mic-1', options: [{ id: 'mic-1', label: 'Studio microphone' }], disabled: false } as const;
        const device = { id: 'mic-1', label: 'Studio microphone' } as const;

        expect(component.trackControl(0, microphone)).toBe('microphone');
        expect(component.trackDevice(0, device)).toBe('mic-1');
    });

    it('opens the quality picker with the selected option active and closes after selection', () => {
        const control = { id: 'quality', label: 'Screen share quality', value: '720p', options: [{ id: '360p', label: '360p' }, { id: '720p', label: '720p' }, { id: '1080p', label: '1080p' }], disabled: false } as const;
        const controlChange = vi.fn().mockName('controlChange');
        component.controls = [control];
        fixture.componentRef.setInput('qualityPickerEnabled', true);
        fixture.componentRef.setInput('showShareAudioOption', true);
        component.controlChange.subscribe(controlChange);

        component.openQualityPicker(control);
        expect(component.qualityPickerOpen).toBe(true);
        expect(component.activeQualityIndex).toBe(1);
        component.selectQuality('quality', '1080p');

        expect(component.qualityPickerOpen).toBe(false);
        expect(controlChange).toHaveBeenCalledTimes(1);
        expect(controlChange).toHaveBeenCalledWith({ id: 'quality', value: '1080p' });
    });

    it('supports bounded keyboard navigation, activation and Escape dismissal', () => {
        const control = { id: 'quality', label: 'Screen share quality', value: '360p', options: [{ id: '360p', label: '360p' }, { id: '720p', label: '720p' }], disabled: false } as const;
        const controlChange = vi.fn().mockName('controlChange');
        component.controls = [control];
        fixture.componentRef.setInput('qualityPickerEnabled', true);
        fixture.componentRef.setInput('showShareAudioOption', true);
        component.controlChange.subscribe(controlChange);
        const key = (key: string): KeyboardEvent => new KeyboardEvent('keydown', { key, cancelable: true });

        component.onQualityKeydown(key('ArrowDown'), control);
        expect(component.qualityPickerOpen).toBe(true);
        expect(component.activeQualityIndex).toBe(0);
        component.onQualityKeydown(key('ArrowDown'), control);
        component.onQualityKeydown(key('ArrowDown'), control);
        expect(component.activeQualityIndex).toBe(1);
        component.onQualityKeydown(key('Enter'), control);
        expect(component.qualityPickerOpen).toBe(false);
        expect(controlChange).toHaveBeenCalledTimes(1);
        expect(controlChange).toHaveBeenCalledWith({ id: 'quality', value: '720p' });

        component.onQualityKeydown(key('Home'), control);
        expect(component.activeQualityIndex).toBe(0);
        component.onQualityKeydown(key('End'), control);
        expect(component.activeQualityIndex).toBe(1);
        component.onQualityKeydown(key('Enter'), control);
        component.onQualityKeydown(key('Escape'), control);
        expect(component.qualityPickerOpen).toBe(false);
    });

    it('closes the rendered quality listbox on Escape, Tab and an outside click', () => {
        component.controls = [{ id: 'quality', label: 'Screen share quality', value: '720p', options: [{ id: '360p', label: '360p' }, { id: '720p', label: '720p' }], disabled: false }];
        fixture.componentRef.setInput('qualityPickerEnabled', true);
        fixture.componentRef.setInput('showShareAudioOption', true);
        fixture.detectChanges();
        const trigger = fixture.nativeElement.querySelector('.call-quality-trigger') as HTMLButtonElement | null;
        expect(trigger).not.toBeNull();

        trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
        fixture.detectChanges();
        expect(document.querySelector('[role="listbox"]')).not.toBeNull();
        trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        fixture.detectChanges();
        expect(document.querySelector('[role="listbox"]')).toBeNull();

        trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
        fixture.detectChanges();
        expect(document.querySelector('[role="listbox"]')).not.toBeNull();
        trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        fixture.detectChanges();
        expect(document.querySelector('[role="listbox"]')).toBeNull();

        trigger?.click();
        fixture.detectChanges();
        expect(document.querySelector('[role="listbox"]')).not.toBeNull();
        document.body.click();
        fixture.detectChanges();
        expect(document.querySelector('[role="listbox"]')).toBeNull();
    });

    it('coalesces overlay positioning and cancels its frame when closed or destroyed', () => {
        const updatePosition = vi.fn().mockName('updatePosition');
        const overlay = { overlayRef: { updatePosition } };
        const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(41);
        const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockReturnValue(undefined);
        component.qualityPickerOpen = true;

        component.refreshQualityPosition(overlay);
        component.refreshQualityPosition(overlay);
        expect(requestFrame).toHaveBeenCalledTimes(1);
        component.closeQualityPicker();
        expect(cancelFrame).toHaveBeenCalledTimes(1);
        expect(cancelFrame).toHaveBeenCalledWith(41);

        component.qualityPickerOpen = true;
        component.refreshQualityPosition(overlay);
        expect(requestFrame).toHaveBeenCalledTimes(2);
        fixture.destroy();
        expect(cancelFrame).toHaveBeenCalledWith(41);
        expect(cancelFrame).toHaveBeenCalledTimes(2);
    });

    it('renders the accessible screen-audio checkbox beside quality and emits its checked value', () => {
        const changed = vi.fn().mockName('shareAudioChange');
        component.controls = [{ id: 'quality', label: 'Screen share quality', value: '720p', options: [{ id: '720p', label: '720p' }], disabled: false }];
        fixture.componentRef.setInput('qualityPickerEnabled', true);
        fixture.componentRef.setInput('showShareAudioOption', true);
        component.shareAudioChange.subscribe(changed);
        fixture.detectChanges();

        const checkbox = fixture.nativeElement.querySelector('.share-audio-toggle input') as HTMLInputElement;
        expect(checkbox.getAttribute('aria-label')).toBe('Share audio');
        expect(fixture.nativeElement.querySelector('.share-audio-label')?.textContent.trim()).toBe('Share audio');
        expect(fixture.nativeElement.querySelector('.share-audio-toggle').getAttribute('title')).toContain('system audio');
        expect(fixture.nativeElement.querySelector('.call-presentation-devices-with-audio .call-quality-control')).not.toBeNull();
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));

        expect(changed).toHaveBeenCalledTimes(1);

        expect(changed).toHaveBeenCalledWith(true);
    });

    it('keeps screen audio visible but disabled with an accessible explanation when unsupported', () => {
        component.controls = [{ id: 'quality', label: 'Screen share quality', value: '720p', options: [{ id: '720p', label: '720p' }], disabled: false }];
        fixture.componentRef.setInput('qualityPickerEnabled', true);
        fixture.componentRef.setInput('showShareAudioOption', true);
        component.shareAudioDisabled = true;
        component.shareAudioTooltip = 'Share audio unavailable: screen sharing is not supported.';
        fixture.detectChanges();

        const checkbox = fixture.nativeElement.querySelector('.share-audio-toggle input') as HTMLInputElement;
        expect(checkbox.disabled).toBe(true);
        expect(checkbox.getAttribute('aria-describedby')).toContain(component.shareAudioStatusID);
        expect(checkbox.getAttribute('aria-description')).toContain('unavailable');
        expect(fixture.nativeElement.querySelector(`#${component.shareAudioStatusID}`)?.textContent).toContain('unavailable');
        expect(fixture.nativeElement.querySelector('.share-audio-unavailable-reason')?.textContent).toContain('screen sharing is not supported');
    });

    it('keeps the quality control in the full-width grid track with or without share audio', () => {
        component.controls = [{ id: 'quality', label: 'Screen share quality', value: '720p', options: [{ id: '720p', label: '720p' }], disabled: false }];
        fixture.detectChanges();

        const quality = fixture.nativeElement.querySelector('.call-quality-control') as HTMLElement;
        expect(fixture.nativeElement.querySelector('.share-audio-toggle')).toBeNull();
        expect(quality.classList).not.toContain('call-quality-feature-enabled');
        expect(quality.querySelector('.call-quality-trigger')).toBeNull();
        expect(quality.querySelector('mat-select')).not.toBeNull();
    });
});
