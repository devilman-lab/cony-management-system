import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PartnersService } from './partners.service';

const ListQuerySchema = z.object({
  q: z.string().trim().min(1).max(60).optional(),
  role: z.enum(['customer', 'supplier']).optional(),
  include_inactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ListQuery = z.infer<typeof ListQuerySchema>;

/** 機能ID M-01 取引先マスタ */
@Controller('masters/partners')
export class PartnersController {
  constructor(private readonly partners: PartnersService) {}

  @Get()
  @RequirePermission('M-01', 'view')
  list(@Query(new ZodValidationPipe(ListQuerySchema)) query: ListQuery) {
    return this.partners.list(query);
  }

  @Get(':id')
  @RequirePermission('M-01', 'view')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.partners.findOne(id);
  }

  /** 受注入力で納品先を選ばせるための一覧（機能ID M-05 納品先マスタ） */
  @Get(':id/delivery-destinations')
  @RequirePermission('M-05', 'view')
  deliveryDestinations(@Param('id', ParseIntPipe) id: number) {
    return this.partners.deliveryDestinations(id);
  }
}
