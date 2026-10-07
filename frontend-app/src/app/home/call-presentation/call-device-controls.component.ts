import {ConnectedPosition, CdkConnectedOverlay, Overlay} from '@angular/cdk/overlay';
import {ChangeDetectionStrategy, Component, EventEmitter, HostListener, Input, OnDestroy, Output, ViewChild} from '@angular/core';
import {CallPresentationControl, CallPresentationControlChange, CallPresentationControlID} from '../call-presentation.model';

@Component({
    standalone: false,
    selector: 'app-call-device-controls',
    templateUrl: './call-device-controls.component.html',
    styleUrls: ['./call-device-controls.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallDeviceControlsComponent implements OnDestroy {
    @Input({required: true}) public controls: readonly CallPresentationControl[] = [];
    @Input({required: true}) public panelClass = 'call-select-panel call-select-panel-dark';
    @Input() public qualityPickerEnabled = false;
    @Input() public qualityPickerOpenBelow = false;
    @Input() public showShareAudioOption = false;
    @Input() public shareAudioChecked = false;
    @Input() public shareAudioDisabled = false;
    @Input() public shareAudioTooltip = 'Include system audio when you share your screen';
    @Input() public shareAudioLabel = 'Share audio';
    @Output() public readonly controlChange = new EventEmitter<CallPresentationControlChange>();
    @Output() public readonly shareAudioChange = new EventEmitter<boolean>();
    public qualityPickerOpen = false;
    public activeQualityIndex = 0;
    public readonly qualityAbovePositions: ConnectedPosition[] = [{originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom'}];
    public readonly qualityBelowPositions: ConnectedPosition[] = [{originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top'}];
    public readonly repositionOnScroll;
    public get overlayPanelClasses(): string[] {
        const classes = this.panelClass.split(/\s+/).filter(Boolean);
        if (this.qualityPickerOpenBelow) classes.push('call-group-quality-picker');
        return classes;
    }
    public get qualityListboxClasses(): string[] {
        const classes = this.panelClass.split(/\s+/).filter(Boolean);
        if (this.qualityPickerOpenBelow) classes.push('call-group-quality-picker');
        return classes;
    }
    @ViewChild('qualityOverlay') private qualityOverlay?: CdkConnectedOverlay;
    private positionFrame: number | null = null;
    public readonly shareAudioDescriptionID = 'call-share-audio-unavailable';
    public get shareAudioStatusID(): string { return `${this.shareAudioDescriptionID}-status`; }
    public get shareAudioDescription(): string {
        if (this.shareAudioDisabled) return this.shareAudioTooltip;
        return this.shareAudioChecked ? 'System audio will be included if the browser provides it.' : 'System audio will not be included.';
    }
    public get shareAudioUnavailableReason(): string | null {
        return this.shareAudioDisabled && this.shareAudioTooltip.toLowerCase().includes('screen sharing is not supported')
            ? this.shareAudioTooltip
            : null;
    }

    public constructor(overlay: Overlay) {
        this.repositionOnScroll = overlay.scrollStrategies.reposition();
    }

    public select(controlID: CallPresentationControlID, value: unknown): void {
        if (typeof value !== 'string') return;
        const control = this.controls.find(item => item.id === controlID);
        if (!control || control.disabled || !control.options.some(option => option.id === value)) return;
        this.controlChange.emit({id: controlID, value});
    }

    public toggleShareAudio(event?: Event): void {
        const input = event?.target;
        if (this.shareAudioDisabled || !(input instanceof HTMLInputElement)) return;
        this.shareAudioChange.emit(input.checked);
    }


    public openQualityPicker(control: CallPresentationControl): void {
        if (control.disabled || control.options.length === 0) return;
        const selectedIndex = control.options.findIndex(option => option.id === control.value);
        this.activeQualityIndex = selectedIndex >= 0 ? selectedIndex : 0;
        this.qualityPickerOpen = true;
    }

    public toggleQualityPicker(control: CallPresentationControl): void {
        if (this.qualityPickerOpen) this.closeQualityPicker();
        else this.openQualityPicker(control);
    }

    public onQualityKeydown(event: KeyboardEvent, control: CallPresentationControl): void {
        if (event.key === 'Escape' && this.qualityPickerOpen) {
            event.preventDefault();
            this.closeQualityPicker();
            return;
        }
        if (event.key === 'Tab' && this.qualityPickerOpen) {
            this.closeQualityPicker();
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            event.preventDefault();
            if (!this.qualityPickerOpen) {
                this.openQualityPicker(control);
                return;
            }
            const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
            this.activeQualityIndex = Math.max(0, Math.min(control.options.length - 1, this.activeQualityIndex + direction));
            return;
        }
        if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            if (!this.qualityPickerOpen) this.openQualityPicker(control);
            this.activeQualityIndex = event.key === 'Home' ? 0 : Math.max(0, control.options.length - 1);
            return;
        }
        if ((event.key === 'Enter' || event.key === ' ') && !this.qualityPickerOpen) {
            event.preventDefault();
            this.openQualityPicker(control);
            return;
        }
        if ((event.key === 'Enter' || event.key === ' ') && this.qualityPickerOpen) {
            event.preventDefault();
            const option = control.options[this.activeQualityIndex];
            if (option) this.selectQuality(control.id, option.id);
        }
    }

    public selectQuality(controlID: CallPresentationControlID, value: string): void {
        this.select(controlID, value);
        this.closeQualityPicker();
    }

    public refreshQualityPosition(overlay: {overlayRef?: {updatePosition(): void}}): void {
        this.scheduleQualityReposition(overlay);
    }

    public closeQualityPicker(): void {
        this.qualityPickerOpen = false;
        this.cancelQualityReposition();
    }

    public ngOnDestroy(): void {
        this.closeQualityPicker();
    }

    @HostListener('window:resize')
    public onViewportResize(): void {
        if (this.qualityPickerOpen) this.scheduleQualityReposition();
    }

    private scheduleQualityReposition(overlay: {overlayRef?: {updatePosition(): void}} | undefined = this.qualityOverlay): void {
        if (!this.qualityPickerOpen || this.positionFrame !== null || !overlay) return;
        this.positionFrame = window.requestAnimationFrame(() => {
            this.positionFrame = null;
            if (this.qualityPickerOpen) overlay.overlayRef?.updatePosition();
        });
    }

    private cancelQualityReposition(): void {
        if (this.positionFrame === null) return;
        window.cancelAnimationFrame(this.positionFrame);
        this.positionFrame = null;
    }

    public selectedLabel(control: CallPresentationControl): string {
        return control.options.find(option => option.id === control.value)?.label ?? control.value;
    }

    public qualityListboxID(control: CallPresentationControl): string {
        return `call-quality-options-${control.id}`;
    }

    public qualityOptionID(control: CallPresentationControl, index: number): string {
        return `${this.qualityListboxID(control)}-${index}`;
    }

    public trackControl(_index: number, control: CallPresentationControl): CallPresentationControl['id'] { return control.id; }
    public trackDevice(_index: number, device: CallPresentationControl['options'][number]): string { return device.id; }
}
