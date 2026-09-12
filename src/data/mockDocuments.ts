import type { LoadedDocument } from '@/types'

type MockDocBase = Omit<LoadedDocument, 'folderPath' | 'absolutePath'>

/**
 * 20 mock documents representing director feedback for Project ECHO (action RPG).
 * Section IDs double as wiki-link slugs.
 * Distribution: Chief×3, Art×5, Plan×4, Level×4, Tech×4
 */
const RAW_MOCK_DOCUMENTS: MockDocBase[] = [
  // ── CHIEF DIRECTOR ────────────────────────────────────────────────────────

  {
    id: 'doc_001',
    filename: 'chief_project_vision.md',
    speaker: 'chief_director',
    date: '2025-03-01',
    tags: ['vision', 'direction', 'alignment'],
    links: ['tone_manner_guide', 'core_mechanics_review', 'level_flow_spec', 'tech_architecture'],
    sections: [
      {
        id: 'chief_project_vision_summary',
        heading: 'Project Vision Summary',
        body: 'Project ECHO의 핵심 방향성은 "몰입형 탐험과 전투의 균형"입니다. 아트 방향([[tone_manner_guide]])과 게임플레이 메카닉([[core_mechanics_review]])이 일관된 경험을 제공해야 합니다. 모든 팀이 이 비전을 공유해야 하며, 부서별 해석 차이를 최소화해야 합니다.',
        wikiLinks: ['tone_manner_guide', 'core_mechanics_review'],
      },
      {
        id: 'chief_project_vision_goals',
        heading: 'Quarterly Goals',
        body: '이번 분기 핵심 목표: 레벨 1~3 구간 완성도 95% 달성([[level_flow_spec]]), 클라이언트 프레임 60fps 안정화([[tech_architecture]]). 각 팀은 부서 OKR을 이 목표에 정렬해야 합니다.',
        wikiLinks: ['level_flow_spec', 'tech_architecture'],
      },
    ],
    rawContent: `---
speaker: chief_director
date: 2025-03-01
tags: [vision, direction, alignment]
links: [[tone_manner_guide]], [[core_mechanics_review]], [[level_flow_spec]], [[tech_architecture]]
---
## Project Vision Summary
Project ECHO의 핵심 방향성은 "몰입형 탐험과 전투의 균형"입니다.

## Quarterly Goals
이번 분기 핵심 목표: 레벨 1~3 구간 완성도 95% 달성.`,
  },

  {
    id: 'doc_002',
    filename: 'chief_q1_retrospective.md',
    speaker: 'chief_director',
    date: '2025-03-28',
    tags: ['retrospective', 'q1', 'issues', 'alignment'],
    links: ['character_color_issues', 'progression_balance_issues', 'dungeon01_issues', 'client_optimization_tasks'],
    sections: [
      {
        id: 'chief_q1_retrospective_findings',
        heading: 'Q1 Retrospective Findings',
        body: 'Q1 주요 문제점 세 가지: (1) 캐릭터 컬러 일관성 부재([[character_color_issues]]), (2) 진행 시스템 밸런스 편차([[progression_balance_issues]]), (3) 팀 간 목표 정렬 실패. 아트팀과 기획팀 간 방향성 갭이 가장 심각한 이슈입니다.',
        wikiLinks: ['character_color_issues', 'progression_balance_issues'],
      },
      {
        id: 'chief_q1_action_items',
        heading: 'Q1 Action Items',
        body: '즉시 조치 사항: 던전1 플로우 재검토([[dungeon01_issues]]), 클라이언트 최적화 착수([[client_optimization_tasks]]). 다음 디렉터 회의까지 각 팀 담당자가 진행 상황을 보고해야 합니다.',
        wikiLinks: ['dungeon01_issues', 'client_optimization_tasks'],
      },
    ],
    rawContent: `---
speaker: chief_director
date: 2025-03-28
tags: [retrospective, q1, issues, alignment]
---
## Q1 Retrospective Findings
Q1 주요 문제점 세 가지.

## Q1 Action Items
즉시 조치 사항 목록.`,
  },

  {
    id: 'doc_003',
    filename: 'chief_milestone_review.md',
    speaker: 'chief_director',
    date: '2025-04-10',
    tags: ['milestone', 'review', 'priority'],
    links: ['feature_priority_list', 'ux_flow_guide', 'area_layout_revisions', 'rendering_spec'],
    sections: [
      {
        id: 'chief_milestone_review_status',
        heading: 'Milestone Review Status',
        body: '마일스톤 M3 달성률 78%. 기능 우선순위 재조정 필요([[feature_priority_list]]). UX 플로우 개선 사항([[ux_flow_guide]])이 M4에 반영되어야 합니다. 현재 가장 큰 리스크는 일정 지연입니다.',
        wikiLinks: ['feature_priority_list', 'ux_flow_guide'],
      },
      {
        id: 'chief_milestone_next_steps',
        heading: 'Next Steps',
        body: '다음 단계: 구역 레이아웃 최종 승인([[area_layout_revisions]]), 렌더링 파이프라인 안정화([[rendering_spec]]). 2주 내에 검증 빌드 배포 예정.',
        wikiLinks: ['area_layout_revisions', 'rendering_spec'],
      },
    ],
    rawContent: `---
speaker: chief_director
date: 2025-04-10
tags: [milestone, review, priority]
---
## Milestone Review Status
마일스톤 M3 달성률 78%.

## Next Steps
다음 단계 조치 사항.`,
  },

  // ── ART DIRECTOR ──────────────────────────────────────────────────────────

  {
    id: 'doc_004',
    filename: 'art_character_color_review.md',
    speaker: 'art_director',
    date: '2025-03-15',
    tags: ['character', 'color', 'tone_manner'],
    links: ['tone_manner_guide', 'core_mechanics_review', 'visual_identity_guide'],
    sections: [
      {
        id: 'tone_manner_guide',
        heading: 'Tone & Manner Guide',
        body: 'Project ECHO의 톤앤매너: 어둡고 신비로운 세계관, 채도 낮은 주조색(먹색+청록), 포인트 컬러는 자주색 계열. 전투 시 이펙트만 고채도 허용. 게임의 코어 루프([[core_mechanics_review]])에서 느끼는 감정과 시각적 톤이 일치해야 합니다.',
        wikiLinks: ['core_mechanics_review'],
      },
      {
        id: 'character_color_issues',
        heading: 'Character Color Issues',
        body: '주인공 캐릭터 의상 색상이 T&M 가이드와 불일치. 현재 버전은 채도가 너무 높고 따뜻한 톤. 즉시 수정 필요. 특히 3번 스킨의 황금색 배색이 세계관과 맞지 않습니다.',
        wikiLinks: [],
      },
      {
        id: 'character_design_actionitems',
        heading: 'Action Items',
        body: '(1) 모든 캐릭터 의상 채도 30% 감소, (2) 따뜻한 톤 → 중성/차가운 톤으로 교체, (3) 수정안을 [[visual_identity_guide]] 기준으로 검토 후 재승인. 담당: 김철수, 기한: 3월 22일.',
        wikiLinks: ['visual_identity_guide'],
      },
    ],
    rawContent: `---
speaker: art_director
date: 2025-03-15
tags: [character, color, tone_manner]
---
## Tone & Manner Guide
Project ECHO 톤앤매너 가이드.

## Character Color Issues
주인공 캐릭터 의상 색상 불일치.

## Action Items
수정 지시 및 담당자.`,
  },

  {
    id: 'doc_005',
    filename: 'art_environment_tonality.md',
    speaker: 'art_director',
    date: '2025-03-20',
    tags: ['environment', 'art', 'lighting', 'atmosphere'],
    links: ['environmental_art_spec', 'level_flow_spec', 'sight_guidance_rules'],
    sections: [
      {
        id: 'environmental_art_spec',
        heading: 'Environmental Art Spec',
        body: '환경 아트 기준: 던전 내부는 암청색 기반 조명, 자연광 차단 효과. 레벨 플로우([[level_flow_spec]])에서 플레이어가 이동하는 경로에 시각적 유도 배치. 오브젝트 밀도는 구역당 최대 150개 제한.',
        wikiLinks: ['level_flow_spec'],
      },
      {
        id: 'environmental_art_issues',
        heading: 'Current Issues',
        body: '1구역 조명이 너무 밝아 분위기 훼손. 시야 유도 지점([[sight_guidance_rules]])에 배치된 오브젝트들이 오히려 시선을 차단하는 문제 발생. 조명 강도 40% 감소 요청.',
        wikiLinks: ['sight_guidance_rules'],
      },
    ],
    rawContent: `---
speaker: art_director
date: 2025-03-20
tags: [environment, art, lighting, atmosphere]
---
## Environmental Art Spec
환경 아트 기준 명세.

## Current Issues
현재 발견된 문제점.`,
  },

  {
    id: 'doc_006',
    filename: 'art_ui_visual_identity.md',
    speaker: 'art_director',
    date: '2025-03-25',
    tags: ['ui', 'visual_identity', 'hud', 'consistency'],
    links: ['visual_identity_guide', 'ux_flow_guide'],
    sections: [
      {
        id: 'visual_identity_guide',
        heading: 'Visual Identity Guide',
        body: 'UI 비주얼 아이덴티티: 폰트는 Gothic계열 단일화, 아이콘 스타일은 라인아이콘 일관 적용, 색상은 스피커 컬러 팔레트 준수. UX 플로우([[ux_flow_guide]])와 시각적 계층구조가 일치해야 합니다.',
        wikiLinks: ['ux_flow_guide'],
      },
      {
        id: 'ui_consistency_issues',
        heading: 'UI Consistency Issues',
        body: '인벤토리, 스킬창, 지도 UI의 폰트 크기와 간격이 제각각. HUD 아이콘 스타일도 3가지가 혼재. 통일 기준표를 만들어 전체 UI 팀에 배포 필요.',
        wikiLinks: [],
      },
    ],
    rawContent: `---
speaker: art_director
date: 2025-03-25
tags: [ui, visual_identity, hud, consistency]
---
## Visual Identity Guide
UI 비주얼 아이덴티티 가이드.

## UI Consistency Issues
현재 UI 일관성 문제.`,
  },

  {
    id: 'doc_007',
    filename: 'art_cinematic_guidelines.md',
    speaker: 'art_director',
    date: '2025-04-01',
    tags: ['cinematic', 'cutscene', 'camera', 'storytelling'],
    links: ['cinematic_style_guide', 'core_mechanics_review'],
    sections: [
      {
        id: 'cinematic_style_guide',
        heading: 'Cinematic Style Guide',
        body: '컷씬 아트 디렉션: 클로즈업 시 피사계심도 효과 필수, 카메라 무빙은 영화적 연출 준수. 전투 직전 컷씬은 긴장감을 위해 채도 추가 감소. 코어 메카닉([[core_mechanics_review]])의 핵심 순간을 컷씬으로 강조.',
        wikiLinks: ['core_mechanics_review'],
      },
      {
        id: 'cinematic_action_items',
        heading: 'Cinematic Action Items',
        body: '(1) 오프닝 컷씬 카메라 무빙 재작업, (2) 보스 등장 연출에 피사계심도 적용, (3) 엔딩 시퀀스 색보정 검토. 담당: 영상팀, 기한: 4월 15일.',
        wikiLinks: [],
      },
    ],
    rawContent: `---
speaker: art_director
date: 2025-04-01
tags: [cinematic, cutscene, camera]
---
## Cinematic Style Guide
컷씬 아트 디렉션 가이드.

## Cinematic Action Items
컷씬 수정 지시.`,
  },

  {
    id: 'doc_008',
    filename: 'art_concept_feedback_202503.md',
    speaker: 'art_director',
    date: '2025-03-18',
    tags: ['concept', 'feedback', 'character', 'iteration'],
    links: ['tone_manner_guide', 'concept_revision_requirements'],
    sections: [
      {
        id: 'concept_feedback_202503',
        heading: 'Concept Art Feedback — March 2025',
        body: '3월 컨셉 아트 배치 피드백: 보스 캐릭터 실루엣은 합격, 색상은 불합격. T&M 가이드([[tone_manner_guide]])에서 명시한 세계관 채도를 초과. 배경 컨셉 3점 중 2점은 재작업 필요.',
        wikiLinks: ['tone_manner_guide'],
      },
      {
        id: 'concept_revision_requirements',
        heading: 'Revision Requirements',
        body: '재작업 항목: 보스 컬러 스킴 3안 제출, 배경 B-02 / B-03 분위기 재해석. 다음 컨셉 배치는 4월 1일 오전 회의에서 진행. 수정 시 반드시 전작 레퍼런스와 비교 슬라이드 포함.',
        wikiLinks: [],
      },
    ],
    rawContent: `---
speaker: art_director
date: 2025-03-18
tags: [concept, feedback, iteration]
---
## Concept Art Feedback — March 2025
3월 컨셉 아트 배치 피드백.

## Revision Requirements
재작업 요구사항.`,
  },

  // ── PLAN DIRECTOR ─────────────────────────────────────────────────────────

  {
    id: 'doc_009',
    filename: 'plan_core_mechanics_review.md',
    speaker: 'plan_director',
    date: '2025-03-10',
    tags: ['mechanics', 'core_loop', 'gameplay', 'feedback'],
    links: ['core_mechanics_review', 'ux_flow_guide', 'progression_spec'],
    sections: [
      {
        id: 'core_mechanics_review',
        heading: 'Core Mechanics Review',
        body: '코어 루프 구조: 탐험 → 전투 → 보상 → 강화 → 탐험. 현재 전투 후 보상 인지율이 낮아 강화 의욕 저하 문제. UX 플로우([[ux_flow_guide]])에서 보상 연출을 더 명확히 표현 필요. 평균 세션 시간: 현재 18분, 목표 25분.',
        wikiLinks: ['ux_flow_guide'],
      },
      {
        id: 'core_mechanics_action',
        heading: 'Action Items',
        body: '(1) 보상 획득 이펙트 강화, (2) 강화 시스템 진입 UI 간소화, (3) 진행 스펙([[progression_spec]]) 검토 후 보상 밸런스 재조정. 플레이 테스트 결과 기반 2주 내 수정.',
        wikiLinks: ['progression_spec'],
      },
    ],
    rawContent: `---
speaker: plan_director
date: 2025-03-10
tags: [mechanics, core_loop, gameplay]
---
## Core Mechanics Review
코어 루프 구조 분석 및 피드백.

## Action Items
즉시 조치 사항.`,
  },

  {
    id: 'doc_010',
    filename: 'plan_progression_system.md',
    speaker: 'plan_director',
    date: '2025-03-17',
    tags: ['progression', 'balance', 'level_design', 'rpg'],
    links: ['progression_spec', 'core_mechanics_review', 'feature_priority_list'],
    sections: [
      {
        id: 'progression_spec',
        heading: 'Progression System Spec',
        body: '진행 시스템 규격: 경험치 곡선은 1~10레벨 선형, 11~30레벨 지수 증가. 스킬 트리는 3갈래 분기. 코어 메카닉([[core_mechanics_review]])과 연동하여 강화가 전투에 즉각 반영되어야 합니다.',
        wikiLinks: ['core_mechanics_review'],
      },
      {
        id: 'progression_balance_issues',
        heading: 'Balance Issues',
        body: '5~8레벨 구간 난이도 스파이크 발견. 기능 우선순위([[feature_priority_list]])에서 밸런스 패치를 긴급으로 격상. 스킬 트리 2번 갈래 선택 비율이 5% 미만으로 사실상 사문화.',
        wikiLinks: ['feature_priority_list'],
      },
    ],
    rawContent: `---
speaker: plan_director
date: 2025-03-17
tags: [progression, balance, level_design]
---
## Progression System Spec
진행 시스템 상세 규격.

## Balance Issues
밸런스 문제 목록.`,
  },

  {
    id: 'doc_011',
    filename: 'plan_feature_priority_q2.md',
    speaker: 'plan_director',
    date: '2025-04-05',
    tags: ['feature', 'priority', 'q2', 'scope'],
    links: ['feature_priority_list', 'tech_architecture', 'performance_budget'],
    sections: [
      {
        id: 'feature_priority_list',
        heading: 'Feature Priority List Q2',
        body: 'Q2 기능 우선순위 (Must/Should/Could): Must: 밸런스 패치, 던전 3 완성, 서버 안정화. Should: 길드 시스템, PvP 기초. Could: 외형 커스터마이징. 기술 아키텍처([[tech_architecture]]) 제약으로 길드 시스템 Q3로 이월.',
        wikiLinks: ['tech_architecture'],
      },
      {
        id: 'feature_cut_decisions',
        heading: 'Feature Cut Decisions',
        body: 'Q2에서 제외된 기능: PvP 리더보드(퍼포먼스 예산[[performance_budget]] 초과), 소환수 시스템(기획 미완성). 컷 결정은 팀장급 합의 사항이며 Q4 재검토 예정.',
        wikiLinks: ['performance_budget'],
      },
    ],
    rawContent: `---
speaker: plan_director
date: 2025-04-05
tags: [feature, priority, q2, scope]
---
## Feature Priority List Q2
Q2 기능 우선순위 목록.

## Feature Cut Decisions
기능 컷 결정 내역.`,
  },

  {
    id: 'doc_012',
    filename: 'plan_ux_flow_review.md',
    speaker: 'plan_director',
    date: '2025-04-08',
    tags: ['ux', 'flow', 'onboarding', 'ui'],
    links: ['ux_flow_guide', 'visual_identity_guide'],
    sections: [
      {
        id: 'ux_flow_guide',
        heading: 'UX Flow Guide',
        body: 'UX 기본 원칙: 신규 유저 온보딩은 3단계 이내, 핵심 기능 접근은 최대 2탭. 비주얼 아이덴티티([[visual_identity_guide]])와 UX 계층구조가 일치해야 직관적 사용성 달성 가능.',
        wikiLinks: ['visual_identity_guide'],
      },
      {
        id: 'ux_issues_q2',
        heading: 'UX Issues Q2',
        body: '발견된 UX 문제: (1) 인벤토리 접근 경로 4탭으로 과다, (2) 퀘스트 수락 후 목적지 표시 불명확, (3) 설정 메뉴 구조 비직관적. 플레이 테스트 피드백 기반으로 우선 2건 수정 착수.',
        wikiLinks: [],
      },
    ],
    rawContent: `---
speaker: plan_director
date: 2025-04-08
tags: [ux, flow, onboarding, ui]
---
## UX Flow Guide
UX 기본 원칙 및 가이드.

## UX Issues Q2
Q2 UX 문제점 목록.`,
  },

  // ── LEVEL DIRECTOR ────────────────────────────────────────────────────────

  {
    id: 'doc_013',
    filename: 'level_dungeon_01_review.md',
    speaker: 'level_director',
    date: '2025-03-12',
    tags: ['dungeon', 'level', 'flow', 'review'],
    links: ['level_flow_spec', 'sight_guidance_rules', 'environmental_art_spec', 'gimmick_framework'],
    sections: [
      {
        id: 'level_flow_spec',
        heading: 'Level Flow Spec',
        body: '레벨 플로우 기본 규격: 구역 간 이동 시간 최대 90초, 전투 밀도 구역당 3~5회, 중간 체크포인트 의무화. 시야 유도([[sight_guidance_rules]])로 플레이어가 자연스럽게 목표 지점으로 이동해야 합니다.',
        wikiLinks: ['sight_guidance_rules'],
      },
      {
        id: 'dungeon01_issues',
        heading: 'Dungeon 01 Issues',
        body: '던전1 발견 문제: B구역에서 플레이어 길 잃음 비율 42%. 환경 아트([[environmental_art_spec]])에서 시각적 유도가 부족. 기믹 프레임워크([[gimmick_framework]])에서 정의한 기믹이 튜토리얼 없이 배치됨.',
        wikiLinks: ['environmental_art_spec', 'gimmick_framework'],
      },
    ],
    rawContent: `---
speaker: level_director
date: 2025-03-12
tags: [dungeon, level, flow, review]
---
## Level Flow Spec
레벨 플로우 기본 규격.

## Dungeon 01 Issues
던전1 발견 문제점.`,
  },

  {
    id: 'doc_014',
    filename: 'level_sight_guidance_spec.md',
    speaker: 'level_director',
    date: '2025-03-19',
    tags: ['sight', 'guidance', 'visual_cue', 'navigation'],
    links: ['sight_guidance_rules', 'level_flow_spec', 'area_layout_guide'],
    sections: [
      {
        id: 'sight_guidance_rules',
        heading: 'Sight Guidance Rules',
        body: '시야 유도 원칙: (1) 목표 지점은 항상 밝은 광원으로 표시, (2) 이동 경로는 바닥 텍스처 변화로 암시, (3) 막힌 길에는 파티클 효과 없음. 레벨 플로우([[level_flow_spec]])와 함께 검토하여 플레이어 이동 패턴 예측.',
        wikiLinks: ['level_flow_spec'],
      },
      {
        id: 'sight_guidance_examples',
        heading: 'Implementation Examples',
        body: '구역 레이아웃([[area_layout_guide]])에서 적용 예시: 복도 끝에 창문 광원 배치로 전진 유도, 갈림길에서 주요 경로쪽 천장 높이 증가. 이 패턴을 모든 신규 레벨에 적용 의무화.',
        wikiLinks: ['area_layout_guide'],
      },
    ],
    rawContent: `---
speaker: level_director
date: 2025-03-19
tags: [sight, guidance, visual_cue, navigation]
---
## Sight Guidance Rules
시야 유도 원칙 규정.

## Implementation Examples
적용 예시.`,
  },

  {
    id: 'doc_015',
    filename: 'level_area_layout_feedback.md',
    speaker: 'level_director',
    date: '2025-03-26',
    tags: ['layout', 'area', 'space', 'feedback'],
    links: ['area_layout_guide', 'level_flow_spec', 'dungeon01_issues'],
    sections: [
      {
        id: 'area_layout_guide',
        heading: 'Area Layout Guide',
        body: '구역 레이아웃 기준: 전투 구역 최소 15m×15m, 탐험 구역 최대 60m×60m. 막힌 공간 비율은 전체의 20% 이하. 레벨 플로우([[level_flow_spec]])에서 정의한 이동 동선을 레이아웃 설계 전에 먼저 확정.',
        wikiLinks: ['level_flow_spec'],
      },
      {
        id: 'area_layout_revisions',
        heading: 'Layout Revisions Required',
        body: '수정 필요 구역: A-2 (전투 공간 협소), B-4 (막힌 공간 비율 35% 초과). 던전1 이슈([[dungeon01_issues]])와 연계하여 B구역 전면 재설계. 2주 내 수정안 제출.',
        wikiLinks: ['dungeon01_issues'],
      },
    ],
    rawContent: `---
speaker: level_director
date: 2025-03-26
tags: [layout, area, space, feedback]
---
## Area Layout Guide
구역 레이아웃 기준.

## Layout Revisions Required
수정 필요 구역 목록.`,
  },

  {
    id: 'doc_016',
    filename: 'level_gimmick_design_doc.md',
    speaker: 'level_director',
    date: '2025-04-03',
    tags: ['gimmick', 'puzzle', 'interaction', 'mechanics'],
    links: ['gimmick_framework', 'core_mechanics_review'],
    sections: [
      {
        id: 'gimmick_framework',
        heading: 'Gimmick Design Framework',
        body: '기믹 설계 프레임워크: 기믹 복잡도 레벨 1~3으로 분류. 레벨1: 누르면 열리는 단순 작동, 레벨2: 순서 퍼즐, 레벨3: 멀티 오브젝트 연계. 코어 메카닉([[core_mechanics_review]])을 활용한 기믹 우선 배치.',
        wikiLinks: ['core_mechanics_review'],
      },
      {
        id: 'gimmick_priority_list',
        heading: 'Gimmick Priority List',
        body: '우선 구현 기믹: 압력판 연계 문(레벨1), 불꽃 퍼즐(레벨2), 시간차 기둥(레벨2). Q2 내 구현 목표. 레벨3 기믹은 던전4 이후 배치 예정.',
        wikiLinks: [],
      },
    ],
    rawContent: `---
speaker: level_director
date: 2025-04-03
tags: [gimmick, puzzle, interaction]
---
## Gimmick Design Framework
기믹 설계 프레임워크.

## Gimmick Priority List
우선 구현 기믹 목록.`,
  },

  // ── PROG DIRECTOR ─────────────────────────────────────────────────────────

  {
    id: 'doc_017',
    filename: 'prog_client_optimization.md',
    speaker: 'prog_director',
    date: '2025-03-13',
    tags: ['performance', 'optimization', 'client', 'fps'],
    links: ['performance_budget', 'tech_architecture', 'rendering_spec'],
    sections: [
      {
        id: 'performance_budget',
        heading: 'Performance Budget',
        body: '퍼포먼스 예산 (타겟: 60fps@1080p): CPU 프레임 시간 12ms 이하, GPU 8ms 이하, 메모리 2GB 이하. 기술 아키텍처([[tech_architecture]])에서 정의한 시스템 구조 준수. 현재 평균 GPU 시간: 14ms (예산 초과).',
        wikiLinks: ['tech_architecture'],
      },
      {
        id: 'client_optimization_tasks',
        heading: 'Optimization Tasks',
        body: '즉시 조치: 렌더링 스펙([[rendering_spec]]) 기준으로 드로우콜 정리, LOD 시스템 재조정, 텍스처 스트리밍 개선. 2주 내 프로파일링 결과 보고 의무화.',
        wikiLinks: ['rendering_spec'],
      },
    ],
    rawContent: `---
speaker: prog_director
date: 2025-03-13
tags: [performance, optimization, client]
---
## Performance Budget
퍼포먼스 예산 기준.

## Optimization Tasks
최적화 작업 목록.`,
  },

  {
    id: 'doc_018',
    filename: 'prog_tech_structure_review.md',
    speaker: 'prog_director',
    date: '2025-03-21',
    tags: ['architecture', 'tech', 'structure', 'design'],
    links: ['tech_architecture', 'performance_budget', 'server_spec'],
    sections: [
      {
        id: 'tech_architecture',
        heading: 'Tech Architecture Overview',
        body: '시스템 아키텍처: ECS(Entity Component System) 기반 클라이언트, REST+WebSocket 혼합 서버 통신. 퍼포먼스 예산([[performance_budget]])을 아키텍처 레벨에서 보장. 모듈 간 의존성 최소화 원칙.',
        wikiLinks: ['performance_budget'],
      },
      {
        id: 'tech_debt_items',
        heading: 'Tech Debt Items',
        body: '기술 부채 목록 (Q2 해소 목표): 레거시 이벤트 시스템 교체, 서버 스펙([[server_spec]]) 기준 맞지 않는 API 인터페이스 8개 수정, 메모리 누수 패치 3건. 우선순위: High.',
        wikiLinks: ['server_spec'],
      },
    ],
    rawContent: `---
speaker: prog_director
date: 2025-03-21
tags: [architecture, tech, structure]
---
## Tech Architecture Overview
시스템 아키텍처 개요.

## Tech Debt Items
기술 부채 목록.`,
  },

  {
    id: 'doc_019',
    filename: 'prog_rendering_pipeline.md',
    speaker: 'prog_director',
    date: '2025-03-29',
    tags: ['rendering', 'pipeline', 'graphics', 'optimization'],
    links: ['rendering_spec', 'tech_architecture'],
    sections: [
      {
        id: 'rendering_spec',
        heading: 'Rendering Pipeline Spec',
        body: '렌더링 파이프라인: Deferred Rendering + Forward Pass 혼합. 그림자: Cascaded Shadow Map 4단계. 포스트프로세싱: TAA + SSAO + Bloom. 기술 아키텍처([[tech_architecture]])의 ECS와 연동하여 렌더 컴포넌트 독립적 처리.',
        wikiLinks: ['tech_architecture'],
      },
      {
        id: 'rendering_optimization_tasks',
        heading: 'Rendering Optimization Tasks',
        body: '최적화 우선순위: (1) 그림자 맵 해상도 2048→1024 다운스케일, (2) 파티클 이펙트 GPU 인스턴싱 적용, (3) LOD 전환 거리 재조정. 최적화 완료 후 아트팀([[tone_manner_guide]] 기준)과 품질 검토.',
        wikiLinks: ['tone_manner_guide'],
      },
    ],
    rawContent: `---
speaker: prog_director
date: 2025-03-29
tags: [rendering, pipeline, graphics]
---
## Rendering Pipeline Spec
렌더링 파이프라인 상세 명세.

## Rendering Optimization Tasks
렌더링 최적화 작업 목록.`,
  },

  {
    id: 'doc_020',
    filename: 'prog_server_spec.md',
    speaker: 'prog_director',
    date: '2025-04-07',
    tags: ['server', 'backend', 'network', 'spec'],
    links: ['server_spec', 'tech_architecture', 'client_optimization_tasks'],
    sections: [
      {
        id: 'server_spec',
        heading: 'Server Specification',
        body: '서버 스펙: 게임 서버 Node.js (WebSocket), 매칭 서버 Go, DB PostgreSQL + Redis 캐싱. 기술 아키텍처([[tech_architecture]])의 REST+WebSocket 혼합 방식에 맞게 API 설계. 최대 동시접속 10,000명 목표.',
        wikiLinks: ['tech_architecture'],
      },
      {
        id: 'server_integration_tasks',
        heading: 'Server Integration Tasks',
        body: '통합 작업: 클라이언트 최적화([[client_optimization_tasks]])와 연계한 패킷 사이즈 최적화, 서버-클라이언트 동기화 레이턴시 100ms 이하 달성. Q2 내 스트레스 테스트 필수.',
        wikiLinks: ['client_optimization_tasks'],
      },
    ],
    rawContent: `---
speaker: prog_director
date: 2025-04-07
tags: [server, backend, network]
---
## Server Specification
서버 상세 명세.

## Server Integration Tasks
서버 통합 작업 목록.`,
  },
]

export const MOCK_DOCUMENTS: LoadedDocument[] = RAW_MOCK_DOCUMENTS.map(d => ({ ...d, folderPath: '', absolutePath: '' }))
