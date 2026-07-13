import { Tabs } from 'expo-router';

/**
 * Authenticated app layout — tab-bar navigator.
 * Auth guard (redirect to login when unauthenticated) will be wired in task 8.
 * Tab icons and NativeWind styling will be added in the UI polish phase.
 */
export default function AppLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: true,
      }}
    >
      {/* ---- Main tab-bar routes ---- */}
      <Tabs.Screen name="dashboard" options={{ title: 'Dashboard' }} />
      <Tabs.Screen name="inventory" options={{ title: 'Inventory' }} />
      <Tabs.Screen name="receive" options={{ title: 'Receive' }} />
      <Tabs.Screen name="count" options={{ title: 'Count' }} />
      <Tabs.Screen name="orders" options={{ title: 'Orders' }} />
      <Tabs.Screen name="recommendations" options={{ title: 'Reorder' }} />
      <Tabs.Screen name="reports" options={{ title: 'Reports' }} />
      <Tabs.Screen name="alerts" options={{ title: 'Alerts' }} />

      {/* ---- inventory sub-routes — hidden from tab bar ---- */}
      <Tabs.Screen name="inventory/[skuId]" options={{ href: null, title: 'Product Detail' }} />
      <Tabs.Screen name="inventory/scan" options={{ href: null, title: 'Scan Barcode' }} />
      <Tabs.Screen name="inventory/adjust" options={{ href: null, title: 'Adjust Stock' }} />

      {/* ---- receive sub-routes — hidden from tab bar ---- */}
      <Tabs.Screen name="receive/[poId]" options={{ href: null, title: 'Receive PO' }} />
      <Tabs.Screen name="receive/adhoc" options={{ href: null, title: 'Ad Hoc Receive' }} />

      {/* ---- count sub-routes — hidden from tab bar ---- */}
      <Tabs.Screen name="count/[sessionId]" options={{ href: null, title: 'Count Session' }} />

      {/* ---- orders sub-routes — hidden from tab bar ---- */}
      <Tabs.Screen name="orders/[poId]" options={{ href: null, title: 'PO Detail' }} />
      <Tabs.Screen name="orders/new" options={{ href: null, title: 'New PO' }} />

      {/* ---- reports sub-routes — hidden from tab bar ---- */}
      <Tabs.Screen name="reports/stock-on-hand" options={{ href: null, title: 'Stock On Hand' }} />
      <Tabs.Screen name="reports/inventory-valuation" options={{ href: null, title: 'Inventory Valuation' }} />
      <Tabs.Screen name="reports/low-stock" options={{ href: null, title: 'Low Stock' }} />
      <Tabs.Screen name="reports/sales-velocity" options={{ href: null, title: 'Sales Velocity' }} />
      <Tabs.Screen name="reports/dead-stock" options={{ href: null, title: 'Dead Stock' }} />
      <Tabs.Screen name="reports/shrinkage" options={{ href: null, title: 'Shrinkage' }} />
      <Tabs.Screen name="reports/po-history" options={{ href: null, title: 'PO History' }} />
      <Tabs.Screen name="reports/ledger" options={{ href: null, title: 'Movement Ledger' }} />

      {/* ---- adjustments sub-routes — hidden from tab bar ---- */}
      <Tabs.Screen name="adjustments/pending" options={{ href: null, title: 'Pending Adjustments' }} />

      {/* ---- settings — hidden from main tab bar ---- */}
      <Tabs.Screen name="settings" options={{ title: 'Settings', href: null }} />

      {/* ---- admin routes — hidden from tab bar, Owner only ---- */}
      <Tabs.Screen name="admin/square-events" options={{ href: null, title: 'Square Events' }} />
    </Tabs>
  );
}
