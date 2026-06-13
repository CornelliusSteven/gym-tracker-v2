# Product Requirements Document: Gym Tracker Responsive Web App

## Product Overview

This is a responsive web app for tracking gym workouts, muscle group focus, and gym habit streaks.

The app has 3 main modules:

1. Workout Tracker
2. Body Part Focus Planner
3. Gym Habit Streak Tracker

The app requires login, and each user has their own unique workout data.

## Product Goals

1. Help users log workouts during gym sessions.
2. Help users track multiple lifts in one session.
3. Help users track multiple muscle groups in one session.
4. Help users see which body parts they trained this week and month.
5. Help users track gym consistency with a streak system.
6. Allow users to manage their own muscle group list.
7. Keep each user's data private and separate.

## Core Modules

## 1. Workout Tracker

Purpose:

Allow users to log exercises, sets, reps, and weight.

Rules:

1. A user must be logged in to create a workout.
2. The workout date is automatically today's date.
3. One gym session can include multiple muscle groups.
4. One gym session can include multiple lifts.
5. Users can choose weight unit: `kg` or `lbs`.
6. A submitted workout cannot be edited.
7. A submitted workout cannot be deleted.

Input Flow:

1. User opens Add Workout.
2. App shows today's date.
3. User selects one or more muscle groups.
4. User enters lift name.
5. User enters number of sets.
6. App shows reps and weight input for each set.
7. App displays `Set 1 of 3`, `Set 2 of 3`, etc.
8. User clicks `Next` until the final set.
9. On the final set, button changes to `Submit`.
10. User can add another lift to the same session.
11. User submits the full workout session.
12. Workout is saved to that user's account.

Required Inputs:

1. Muscle group or groups.
2. Lift name.
3. Number of sets.
4. Reps per set.
5. Weight per set.
6. Weight unit: `kg` or `lbs`.

Example:

```text
Date: Wednesday, 27 May
Muscle Groups: Chest, Triceps
Lift: Bench Press
Set 1: 10 reps, 40 kg
Set 2: 8 reps, 45 kg
Set 3: 6 reps, 50 kg
```

## 2. Body Part Focus Planner

Purpose:

Show which muscle groups the user trained and help the user balance their routine.

Rules:

1. Calendar week starts on Monday.
2. The calendar shows muscle groups from submitted workouts.
3. If multiple muscle groups are trained on one day, all should appear on that day.
4. Muscle group list is user-defined.
5. Muscle group list can be edited after setup.
6. Existing submitted workout history should keep the muscle group names that were saved at submission time.

Displays:

1. Weekly calendar view.
2. Monthly calendar view.
3. Muscle groups trained each day.
4. Weekly muscle group count.
5. Monthly muscle group count.

Example:

```text
Wednesday, 27 May: Chest, Triceps
Friday, 29 May: Back, Biceps
Saturday, 30 May: Legs
```

Weekly Summary Example:

```text
Chest: 1 time
Triceps: 1 time
Back: 1 time
Biceps: 1 time
Legs: 1 time
```

## 3. Gym Habit Streak Tracker

Purpose:

Track gym consistency and motivation.

Updated Streak Rule:

The app supports rest days. A streak does not break immediately when the user skips a day.

A streak continues as long as the user does not go 7 consecutive days without submitting a workout.

If the user has no submitted workout for 7 consecutive days, the streak is lost.

Examples:

```text
Monday: workout
Tuesday: rest
Wednesday: rest
Thursday: workout
Current streak continues
```

```text
Monday: workout
Tuesday-Sunday: no workout
Next Monday: still no workout
Streak is gone
```

Streak Displays:

1. Current streak.
2. Longest streak.
3. Gym days this week.
4. Gym days this month.
5. Muscle groups trained this week.
6. Muscle groups trained this month.

Streak Calculation:

1. A gym day is a date with at least one submitted workout.
2. Multiple workouts on the same date count as one gym day.
3. Rest days do not increase the streak count.
4. Rest days do not break the streak unless the user reaches 7 consecutive days without a workout.
5. Current streak counts gym days only, not rest days.
6. Longest streak counts gym days only, using the same 7-day gap rule.

Example:

```text
Workout days:
May 1, May 3, May 6

Current streak: 3 gym days
```

Because there is no 7-day gap between workout days, the streak continues.

## Authentication & Users

Requirements:

1. The app must require login.
2. Each user must have a unique account.
3. Each user can only access their own workout data.
4. Each user can manage their own muscle group list.
5. Workout history must be connected to the logged-in user.

Possible login fields:

```text
Email
Password
```

## Main Pages / Screens

## 1. Login / Register Page

Purpose:

Allow each user to create and access their own account.

Requirements:

1. User can register.
2. User can log in.
3. User cannot access workout data unless logged in.

## 2. Dashboard

Shows:

1. Current streak.
2. Longest streak.
3. Gym days this week.
4. Gym days this month.
5. Most trained muscle group this week.
6. Button to add workout.
7. Calendar preview.

## 3. Add Workout Page

Shows:

1. Today's date.
2. Muscle group multi-select.
3. Weight unit selector: `kg` or `lbs`.
4. Lift name input.
5. Number of sets input.
6. Step-by-step reps and weight input.
7. `Next` button before final set.
8. `Submit` button on final set.
9. Add another lift option.

## 4. Body Focus Calendar Page

Shows:

1. Weekly calendar view.
2. Monthly calendar view.
3. Calendar starting on Monday.
4. Muscle groups trained per date.
5. Weekly muscle group summary.
6. Monthly muscle group summary.

## 5. Streak / Habit Page

Shows:

1. Current streak.
2. Longest streak.
3. Gym days this week.
4. Gym days this month.
5. Weekly muscle group count.
6. Monthly muscle group count.

## 6. Muscle Group Management Page

Shows:

1. Current muscle group list.
2. Add muscle group.
3. Edit muscle group.
4. Remove muscle group from available options.

Important rule:

Removing or editing a muscle group should not change old submitted workout records.

## Functional Requirements

1. User can register.
2. User can log in.
3. User can log out.
4. User can define muscle groups.
5. User can edit muscle groups.
6. User can remove muscle groups from future use.
7. User can submit a workout.
8. User cannot edit submitted workouts.
9. User cannot delete submitted workouts.
10. User can select multiple muscle groups in one session.
11. User can add multiple lifts in one session.
12. User can choose `kg` or `lbs`.
13. App automatically uses today's date.
14. App shows `Set X of Y`.
15. App shows `Next` until the final set.
16. App changes to `Submit` on the final set.
17. App saves workout history per user.
18. App displays trained muscle groups on a Monday-start calendar.
19. App calculates gym days this week.
20. App calculates gym days this month.
21. App calculates current streak using the 7-day gap rule.
22. App calculates longest streak using the 7-day gap rule.
23. App calculates muscle group counts weekly.
24. App calculates muscle group counts monthly.
25. App works responsively on desktop, tablet, and mobile.

## Data Requirements

User:

```text
id
email
passwordHash
createdAt
updatedAt
```

Muscle Group:

```text
id
userId
name
isActive
createdAt
updatedAt
```

Workout Session:

```text
id
userId
date
muscleGroupsSnapshot
lifts
createdAt
```

Lift:

```text
id
name
sets
```

Set:

```text
setNumber
reps
weight
unit
```

Example Workout Session:

```json
{
  "id": "session_001",
  "userId": "user_001",
  "date": "2026-05-27",
  "muscleGroupsSnapshot": ["Chest", "Triceps"],
  "lifts": [
    {
      "id": "lift_001",
      "name": "Bench Press",
      "sets": [
        {
          "setNumber": 1,
          "reps": 10,
          "weight": 40,
          "unit": "kg"
        },
        {
          "setNumber": 2,
          "reps": 8,
          "weight": 45,
          "unit": "kg"
        }
      ]
    }
  ],
  "createdAt": "2026-05-27T10:30:00Z"
}
```

## Non-Functional Requirements

1. The app must be responsive.
2. The app must be easy to use during a gym session.
3. The workout input flow should be simple on mobile.
4. User data must be separated by account.
5. Submitted workout history must be protected from accidental changes.
6. Dashboard and summaries should update after workout submission.
7. Calendar should be readable on small screens.
8. The app should keep saved data after logout and browser close.

## Success Criteria

The product is successful when:

1. A user can register and log in.
2. A user can manage their muscle groups.
3. A user can submit a workout with multiple muscle groups.
4. A user can submit multiple lifts in one session.
5. A user can enter set-by-set reps and weight.
6. A user can choose between `kg` and `lbs`.
7. A user can see trained muscle groups on a Monday-start calendar.
8. A user can see weekly and monthly gym days.
9. A user can see weekly and monthly muscle group counts.
10. A user can see current and longest streak.
11. A user's streak survives rest days unless there are 7 consecutive days without workout.
12. A user cannot edit or delete submitted workouts.
