import {NgModule} from '@angular/core';
import {LoadingSpinnerComponent} from './loading-spinner/loading-spinner.component';
import {ZweiIconComponent} from './zwei-icon/zwei-icon.component';
import {SwipeBackDirective} from './swipe-back.directive';
import {PullToRefreshDirective} from './pull-to-refresh.directive';

@NgModule({
    declarations: [LoadingSpinnerComponent, ZweiIconComponent, SwipeBackDirective, PullToRefreshDirective],
    exports: [LoadingSpinnerComponent, ZweiIconComponent, SwipeBackDirective, PullToRefreshDirective],
})
export class SharedModule {}
