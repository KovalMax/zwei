import {ChangeDetectionStrategy, Component, EventEmitter, Input, Output} from '@angular/core';
import {CallPresentationControl, CallPresentationControlChange, CallPresentationControlID} from '../call-presentation.model';

@Component({
    standalone: false,
    selector: 'app-call-device-controls',
    templateUrl: './call-device-controls.component.html',
    styleUrls: ['./call-device-controls.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallDeviceControlsComponent {
    @Input({required: true}) public controls: readonly CallPresentationControl[] = [];
    @Input({required: true}) public panelClass = 'call-select-panel call-select-panel-dark';
    @Output() public readonly controlChange = new EventEmitter<CallPresentationControlChange>();

    public select(controlID: CallPresentationControlID, value: unknown): void {
        if (typeof value !== 'string') return;
        const control = this.controls.find(item => item.id === controlID);
        if (!control || control.disabled || !control.options.some(option => option.id === value)) return;
        this.controlChange.emit({id: controlID, value});
    }

    public trackControl(_index: number, control: CallPresentationControl): CallPresentationControl['id'] { return control.id; }
    public trackDevice(_index: number, device: CallPresentationControl['options'][number]): string { return device.id; }
}
