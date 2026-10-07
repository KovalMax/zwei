import {ChangeDetectionStrategy, Component, EventEmitter, Input, Output} from '@angular/core';

@Component({
    standalone: false,
    selector: 'app-call-terminal-notice',
    templateUrl: './call-terminal-notice.component.html',
    styleUrls: ['./call-terminal-notice.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallTerminalNoticeComponent {
    @Input({required: true}) public message = '';
    @Input() public error = false;
    @Input() public group = false;
    @Input() public rejoinable = false;
    @Output() public readonly rejoin = new EventEmitter<void>();
}
