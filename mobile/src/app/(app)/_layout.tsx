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
      <Tabs.Screen name="receive" options={{ title: 'Receive' }} />
      {/* receive sub-routes — hidden from tab bar */}
      <Tabs.Screen name="receive/[poId]" options={{ href: null, title: 'Receive PO' }} />
      <Tabs.Screen name="receive/adhoc" options={{ href: null, title: 'Ad Hoc Receive' }} />
      <Tabs.Screen name="count" options={{ title: 'Count' }} />
      <Tabs.Screen name="orders" options={{ title: 'Orders' }} />
      <Tabs.Screen name="recommendations" options={{ title: 'Reorder' }} />
      <Tabs.Screen name="reports" options={{ title: 'Reports' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', href: null }} />
      {/* adjustments sub-routes — hidden from tab bar */}
      <Tabs.Screen name="adjustments/pending" options={{ href: null, title: 'Pending Adjustments' }} />
    </Tabs>
  );
}
