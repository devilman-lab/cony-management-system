import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard, PermissionsGuard } from './auth/guards';
import { DatabaseModule } from './db/database.module';
import { NumberingService } from './common/numbering.service';
import { SettingsService } from './common/settings.service';
import { BillingController } from './billing/billing.controller';
import { BillingService } from './billing/billing.service';
import { RoyaltyService } from './billing/royalty.service';
import { HealthController } from './health/health.controller';
import { AdjustmentsService } from './inventory/adjustments.service';
import { InventoryController } from './inventory/inventory.controller';
import { ReceiptsService } from './inventory/receipts.service';
import { StockLedgerService } from './inventory/stock-ledger.service';
import { StocksController } from './inventory/stocks.controller';
import { StocksService } from './inventory/stocks.service';
import { LookupsController } from './masters/lookups.controller';
import { PartnersController } from './masters/partners.controller';
import { PartnersService } from './masters/partners.service';
import { ProductsController } from './masters/products.controller';
import { ProductsService } from './masters/products.service';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { PurchasingController } from './purchasing/purchasing.controller';
import { PurchasingService } from './purchasing/purchasing.service';
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
    StocksController,
    InventoryController,
    ReturnsController,
    OrdersController,
    ShipmentsController,
    BillingController,
    PurchasingController,
  ],
  providers: [
    BillingService,
    RoyaltyService,
    PurchasingService,
    PartnersService,
    ProductsService,
    StocksService,
    StockLedgerService,
    ReceiptsService,
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
  ],
})
export class AppModule {}
