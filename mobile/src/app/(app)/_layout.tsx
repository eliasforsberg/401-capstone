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
        headerShown: false,
      }}
    >
      <Tabs.Screen name="dashboard" options={{ title: 'Dashboard' }} />
      <Tabs.Screen name="inventory" options={{ title: 'Inventory' }} />
      {/* inventory sub-routes — hidden from tab bar */}
      <Tabs.Screen name="inventory/[skuId]" options={{ href: null, title: 'Product Detail' }} />
      <Tabs.Screen name="inventory/scan" options={{ href: null, title: 'Scan Barcode' }} />
      <Tabs.Screen name="inventory/adjust" options={{ href: null, title: 'Adjust Stock' }} />
      <Tabs.Screen name="receive" options={{ title: 'Receive' }} />
      {/* receive sub-routes — hidden from tab bar */}
      <Tabs.Screen name="receive/[poId]" options={{ href: null, title: 'Receive PO' }} />
      <Tabs.Screen name="receive/adhoc" options={{ href: null, title: 'Ad Hoc Receive' }} />
      <Tabs.Screen name="count" options={{ title: 'Count' }} />
      {/* count sub-routes — hidden from tab bar */}
      <Tabs.Screen name="count/[sessionId]" options={{ href: null, title: 'Count Session' }} />
      <Tabs.Screen name="orders" options={{ title: 'Orders' }} />
      {/* orders sub-routes — hidden from tab bar */}
      <Tabs.Screen name="orders/[poId]" options={{ href: null, title: 'PO Detail' }} />
      <Tabs.Screen name="orders/new" options={{ href: null, title: 'New PO' }} />
      <Tabs.Screen name="recommendations" options={{ title: 'Reorder' }} />
      <Tabs.Screen name="reports" options={{ title: 'Reports' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', href: null }} />
      {/* adjustments sub-routes — hidden from tab bar */}
      <Tabs.Screen name="adjustments/pending" options={{ href: null, title: 'Pending Adjustments' }} />
    </Tabs>
  );
}
