import { createFileRoute } from '@tanstack/react-router'
import { ShopPage } from '@/pa-local/shop/shop-page'
export const Route = createFileRoute('/(auth)/pa-shop')({ component: ShopPage })
