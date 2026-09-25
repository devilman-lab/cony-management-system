import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard, PermissionsGuard } from './auth/guards';
import { DatabaseModule } from './db/database.module';
import { AuditInterceptor } from './common/audit.interceptor';
import { NumberingService } from './common/numbering.service';
import { SettingsService } from './common/settings.service';
import { UsersController } from './admin/users.controller';
import { UsersService } from './admin/users.service';
import { AnalyticsController } from './analytics/analytics.controller';
import { AttachmentsController } from './attachments/attachments.controller';
import { AttachmentsService } from './attachments/attachments.service';
import { PostalCodesController } from './reference/postal-codes.controller';
import { PostalCodesService } from './reference/postal-codes.service';
import { SalesSchedulesController } from './planning/sales-schedules.controller';
import { SalesSchedulesService } from './planning/sales-schedules.service';
import { AnalyticsService } from './analytics/analytics.service';
import { BillingController } from './billing/billing.controller';
import { BillingService } from './billing/billing.service';
import { RoyaltyService } from './billing/royalty.service';
import { HealthController } from './health/health.controller';
import { AdjustmentsService } from './inventory/adjustments.service';
import { InventoryController } from './inventory/inventory.controller';
import { ReceiptsService } from './inventory/receipts.service';
import { ReservationsService } from './inventory/reservations.service';
import { StockLedgerService } from './inventory/stock-ledger.service';
import { StocksController } from './inventory/stocks.controller';
import { ImportsController } from './imports/imports.controller';
import { AmazonImportService } from './imports/amazon-import.service';
import { OmsImportService } from './imports/oms-import.service';
import { PartnerOrderImportService } from './imports/partner-order-import.service';
import { StocksService } from './inventory/stocks.service';
import { LookupsController } from './masters/lookups.controller';
import { MastersCrudService } from './masters/masters-crud.service';
import { MastersWriteController } from './masters/masters-write.controller';
import { PartnersController } from './masters/partners.controller';
import { PartnersService } from './masters/partners.service';
import { ProductsController } from './masters/products.controller';
import { ProductsService } from './masters/products.service';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { PurchasingController } from './purchasing/purchasing.controller';
import { PurchasingService } from './purchasing/purchasing.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { ReturnsController } from './returns/returns.controller';
import { ReturnsService } from './returns/returns.service';
import { AllocationService } from './shipping/allocation.service';
import { ShipmentsController } from './shipping/shipments.controller';
import { ShipmentsService } from './shipping/shipments.service';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [
    HealthController,
    PartnersController,
    ProductsController,
    LookupsController,
    MastersWriteController,
    StocksController,
    InventoryController,
    ReturnsController,
    OrdersController,
    ShipmentsController,
    BillingController,
    PurchasingController,
    ImportsController,
    AnalyticsController,
    UsersController,
    ReportsController,
    PostalCodesController,
    SalesSchedulesController,
    AttachmentsController,
  ],
  providers: [
    UsersService,
    ReportsService,
    PostalCodesService,
    SalesSchedulesService,
    AttachmentsService,
    BillingService,
    RoyaltyService,
    PurchasingService,
    PartnerOrderImportService,
    OmsImportService,
    AmazonImportService,
    AnalyticsService,
    PartnersService,
    ProductsService,
    MastersCrudService,
    StocksService,
    StockLedgerService,
    ReceiptsService,
    ReservationsService,
    AdjustmentsService,
    ReturnsService,
    OrdersService,
    AllocationService,
    ShipmentsService,
    NumberingService,
    SettingsService,
    // 既定で全経路を認証必須にする。開けたい経路にだけ @Public() を付ける。
    // 「付け忘れたら守られない」ではなく「付け忘れたら通れない」向きにしておく。
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // 誰が・いつ・何を変えたかを audit_logs に残す。記録する経路は audit.interceptor.ts の表で決める。
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
