import {NgModule} from '@angular/core';
import {LoadingSpinnerComponent} from './loading-spinner/loading-spinner.component';
import {ZweiIconComponent} from './zwei-icon/zwei-icon.component';

@NgModule({
    declarations: [LoadingSpinnerComponent, ZweiIconComponent],
    exports: [LoadingSpinnerComponent, ZweiIconComponent],
})
export class SharedModule {}
