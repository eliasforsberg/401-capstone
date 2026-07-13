import { useRouter } from 'expo-router';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

// ---------------------------------------------------------------------------
// Report menu item definition
// ---------------------------------------------------------------------------

interface ReportItem {
  title: string;
  description: string;
  route: string;
  icon: string;
}

const REPORTS: ReportItem[] = [
  {
    title: 'Stock On Hand',
    description: 'Current balance, cost, and value for every SKU',
    route: '/(app)/reports/stock-on-hand',
    icon: '📦',
  },
  {
    title: 'Inventory Valuation',
    description: 'Cost vs selling price and total portfolio value',
    route: '/(app)/reports/inventory-valuation',
    icon: '💰',
  },
  {
    title: 'Low Stock',
    description: 'SKUs at or below reorder point with stockout projections',
    route: '/(app)/reports/low-stock',
    icon: '⚠️',
  },
  {
    title: 'Sales Velocity',
    description: 'Units sold per day over last 30 days, ranked by velocity',
    route: '/(app)/reports/sales-velocity',
    icon: '📈',
  },
  {
    title: 'Dead Stock',
    description: 'SKUs with zero sales in the last 60 days',
    route: '/(app)/reports/dead-stock',
    icon: '🪦',
  },
  {
    title: 'Shrinkage',
    description: 'Damage, spoilage, and theft adjustments by date',
    route: '/(app)/reports/shrinkage',
    icon: '📉',
  },
  {
    title: 'PO History',
    description: 'All purchase orders filtered by status',
    route: '/(app)/reports/po-history',
    icon: '🗂️',
  },
  {
    title: 'Movement Ledger',
    description: 'Full inventory movement history with filters',
    route: '/(app)/reports/ledger',
    icon: '📋',
  },
];

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ReportsIndexScreen() {
  const router = useRouter();

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.screenTitle}>Reports</Text>
      <Text style={styles.screenSubtitle}>Tap any report to view details</Text>

      <View style={styles.listContainer}>
        {REPORTS.map((report, index) => (
          <TouchableOpacity
            key={report.route}
            style={[
              styles.row,
              index === REPORTS.length - 1 && styles.rowLast,
            ]}
            onPress={() => router.push(report.route as never)}
            activeOpacity={0.7}
          >
            <Text style={styles.rowIcon}>{report.icon}</Text>
            <View style={styles.rowContent}>
              <Text style={styles.rowTitle}>{report.title}</Text>
              <Text style={styles.rowDescription}>{report.description}</Text>
            </View>
            <Text style={styles.rowChevron}>›</Text>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 40,
  },
  screenTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1C1C1E',
    marginBottom: 2,
  },
  screenSubtitle: {
    fontSize: 13,
    color: '#8E8E93',
    marginBottom: 20,
  },
  listContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
    gap: 12,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowIcon: {
    fontSize: 22,
    width: 32,
    textAlign: 'center',
  },
  rowContent: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '500',
    color: '#1C1C1E',
    marginBottom: 2,
  },
  rowDescription: {
    fontSize: 12,
    color: '#8E8E93',
  },
  rowChevron: {
    fontSize: 20,
    color: '#C7C7CC',
    fontWeight: '300',
  },
});
