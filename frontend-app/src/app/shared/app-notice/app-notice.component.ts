import {Component, EventEmitter, Input, Output} from '@angular/core';

export type AppNoticeKind = 'info' | 'success' | 'warning' | 'error';

@Component({
    standalone: false,
    selector: 'app-notice',
    templateUrl: './app-notice.component.html',
    styleUrls: ['./app-notice.component.css'],
})
export class AppNoticeComponent {
    @Input() public kind: AppNoticeKind = 'info';
    @Input() public message = '';
    @Input() public actionLabel = '';
    @Input() public actionDisabled = false;
    @Input() public compact = false;
    @Output() public readonly action = new EventEmitter<void>();

    public get role(): 'alert' | 'status' {
        return this.kind === 'error' ? 'alert' : 'status';
    }

    public get live(): 'assertive' | 'polite' {
        return this.kind === 'error' ? 'assertive' : 'polite';
    }
}
