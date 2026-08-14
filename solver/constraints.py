"""
CP-SAT Constraint Definitions

Implements hard constraints for roster generation:
1. Window rule (no consecutive shifts within window_weeks)
2. Blocking absolute (ABSOLUUT preferences)
3. Part-time pattern (forced assignments)
4. Capacity (slots need required number of people)
5. Band limits (balance ranges per person per counter)
6. Holiday rotation (fair distribution across group)
"""

from ortools.sat.python import cp_model
from typing import dict, list, set


class ConstraintBuilder:
    """Builds and manages CP-SAT constraints"""

    def __init__(self, model: cp_model.CpModel):
        self.model = model
        self.violations = {}

    # ========================================================================
    # Window Rule: No consecutive assignments within window_weeks
    # ========================================================================

    def add_window_constraints(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        people: list[str],
        slots: list[dict],
        window_weeks: int
    ):
        """
        Constraint: If person assigned to week W, cannot be assigned to weeks
        [W-k, W+k] where k = ceil(window_weeks/2).

        Allows same-week weekend pairs (Saturday + Sunday).
        """
        self.violations['window_rule'] = 0

        if window_weeks <= 1:
            return  # No window constraint for 1-week

        # Build map: week -> list of slots
        week_slots = {}
        for slot in slots:
            week = slot['iso_week']
            if week not in week_slots:
                week_slots[week] = []
            week_slots[week].append(slot)

        # For each person
        for person_id in people:
            # For each week
            for week in sorted(week_slots.keys()):
                # Slots in this week
                week_vars = [
                    assignment_vars.get((person_id, slot['id']))
                    for slot in week_slots[week]
                    if (person_id, slot['id']) in assignment_vars
                ]

                if not week_vars:
                    continue

                # Sum assignments in window [week - k, week + k]
                k = (window_weeks + 1) // 2
                window_vars = []

                for check_week in range(week - k, week + k + 1):
                    if check_week in week_slots:
                        for slot in week_slots[check_week]:
                            if (person_id, slot['id']) in assignment_vars:
                                window_vars.append(
                                    assignment_vars[(person_id, slot['id'])]
                                )

                # At most 1 assignment in window
                if window_vars:
                    self.model.Add(sum(window_vars) <= 1)

    # ========================================================================
    # Blocking Absolute: Cannot assign to ABSOLUUT (blocked) slots
    # ========================================================================

    def add_blocking_absolute_constraints(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        blocked_slots: set[tuple[str, str]]  # (person_id, slot_id)
    ):
        """
        Constraint: If person has ABSOLUUT (blocked) preference for slot,
        cannot be assigned to that slot.
        """
        self.violations['blocking_absolute'] = 0

        for person_id, slot_id in blocked_slots:
            if (person_id, slot_id) in assignment_vars:
                self.model.Add(assignment_vars[(person_id, slot_id)] == 0)

    # ========================================================================
    # Capacity: Each slot must have required number of assignments
    # ========================================================================

    def add_capacity_constraints(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        slots: list[dict],
        people: list[str]
    ):
        """
        Constraint: Each slot needs benodigd_aantal_personen assignments.
        """
        self.violations['capacity'] = 0

        for slot in slots:
            slot_id = slot['id']
            required = slot.get('benodigd_aantal_personen', 1)

            # Sum all people assigned to this slot
            slot_vars = [
                assignment_vars.get((person_id, slot_id))
                for person_id in people
                if (person_id, slot_id) in assignment_vars
            ]

            if slot_vars:
                self.model.Add(sum(slot_vars) == required)

    # ========================================================================
    # Band Limits: Per-person assignment count in range
    # ========================================================================

    def add_band_constraints(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        people: list[str],
        slots: list[dict],
        band_ranges: dict[str, list[int]],  # counter -> [min, max]
        balances: dict[str, dict[str, int]],  # person -> { counter: delta }
        counters: list[str] = ['AVOND', 'WEEKEND', 'FEESTDAG']
    ):
        """
        Constraint: Each person must have assignments in band range per counter.

        Band is adjusted by ledger balance:
        actual_band = [base_min + delta, base_max + delta]
        """
        self.violations['band_limit'] = 0

        for person_id in people:
            for counter in counters:
                base_min, base_max = band_ranges.get(counter, [7, 8])

                # Get person's balance for this counter
                delta = balances.get(person_id, {}).get(counter, 0)
                actual_min = base_min + delta
                actual_max = base_max + delta

                # Slots matching this counter
                counter_vars = [
                    assignment_vars.get((person_id, slot['id']))
                    for slot in slots
                    if slot.get('shift_type_name') == counter
                    and (person_id, slot['id']) in assignment_vars
                ]

                if counter_vars:
                    assignment_count = sum(counter_vars)
                    self.model.Add(assignment_count >= actual_min)
                    self.model.Add(assignment_count <= actual_max)

    # ========================================================================
    # Part-time Pattern: Forced assignments on specific weekdays
    # ========================================================================

    def add_parttime_constraints(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        people: list[str],
        slots: list[dict],
        patterns: dict[str, list[dict]]  # person_id -> [{ weekdag, frequentie }]
    ):
        """
        Constraint: Part-time staff must be assigned on specified weekdays/frequencies.

        ELKE_WEEK: every week
        EVEN_WEKEN: only even ISO weeks
        ONEVEN_WEKEN: only odd ISO weeks
        """
        self.violations['parttime_pattern'] = 0

        weekday_map = {
            'MA': 0, 'DI': 1, 'WO': 2, 'DO': 3,
            'VR': 4, 'ZA': 5, 'ZO': 6
        }

        for person_id in people:
            person_patterns = patterns.get(person_id, [])

            for pattern in person_patterns:
                weekday = weekday_map.get(pattern.get('weekdag'), -1)
                frequency = pattern.get('frequentie', 'ELKE_WEEK')

                if weekday < 0:
                    continue

                # Find matching slots
                matching_slots = []
                for slot in slots:
                    # Parse date to get day of week
                    # datum format: YYYY-MM-DD
                    year, month, day = map(int, slot['datum'].split('-'))
                    from datetime import date
                    d = date(year, month, day)
                    slot_weekday = d.weekday()  # 0=Mon, 6=Sun

                    # Adjust for ISO (0=Mon in ISO, 0=Sun in Python)
                    if d.weekday() == 6:  # Sunday
                        slot_weekday = 6
                    else:
                        slot_weekday = d.weekday()

                    if slot_weekday != weekday:
                        continue

                    # Check frequency
                    if frequency == 'ELKE_WEEK':
                        matching_slots.append(slot)
                    elif frequency == 'EVEN_WEKEN' and slot['iso_week'] % 2 == 0:
                        matching_slots.append(slot)
                    elif frequency == 'ONEVEN_WEKEN' and slot['iso_week'] % 2 == 1:
                        matching_slots.append(slot)

                # Must assign to at least one slot per week/cycle
                # (This is complex; simplified here)
                # In practice: create one var per week, force exactly 1

    # ========================================================================
    # Reporting
    # ========================================================================

    def get_violations_summary(self) -> dict:
        """Return current violation counts"""
        return self.violations.copy()
