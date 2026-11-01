import {CommonModule} from '@angular/common';
import {NgModule} from '@angular/core';
import {LoadingSpinnerComponent} from './loading-spinner/loading-spinner.component';
import {ZweiIconComponent} from './zwei-icon/zwei-icon.component';
import {SwipeBackDirective} from './swipe-back.directive';
import {PullToRefreshDirective} from './pull-to-refresh.directive';
import {AppNoticeComponent} from './app-notice/app-notice.component';

@NgModule({
    declarations: [LoadingSpinnerComponent, ZweiIconComponent, SwipeBackDirective, PullToRefreshDirective, AppNoticeComponent],
    imports: [CommonModule],
    exports: [LoadingSpinnerComponent, ZweiIconComponent, SwipeBackDirective, PullToRefreshDirective, AppNoticeComponent],
})
export class SharedModule {}
