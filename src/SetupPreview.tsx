import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from './theme';

const examples = [
  {
    label: '여행 계획',
    prompt: '바닷가 마을에 반나절만 머물러. 산책과 시장 구경을 넣은 일정을 짜 줘.',
    answer: '아침에는 해변을 따라 천천히 걸어 보세요. 점심에는 시장에서 간식을 골라 먹고, 돌아가기 전에 바다가 보이는 곳에서 잠깐 쉬면 여유로운 반나절이 돼요.',
  },
  {
    label: '글 다듬기',
    prompt: '“오늘 좀 늦을 것 같아”를 약속 상대에게 보낼 정중한 메시지로 바꿔 줘.',
    answer: '기다리게 해서 미안해요. 오늘 약속 시간보다 조금 늦을 것 같아요. 도착 시간을 확인하는 대로 바로 연락드릴게요.',
  },
  {
    label: '그림 그리기',
    prompt: '보랏빛 노을 아래 작은 섬과 등대를 그려줘.',
    answer: '등대 불빛이 잔잔한 바다에 길게 비치고, 하늘은 연보라색에서 짙은 자주색으로 물들어요. 이런 장면을 그림으로 요청할 수 있어요.',
  },
];

export const SetupPreview = memo(function SetupPreview({ onChoosePrompt }: { onChoosePrompt: (prompt: string) => void }) {
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState<number | null>(null);
  const example = examples[active];

  const togglePrompt = () => {
    const next = chosen === active ? null : active;
    setChosen(next);
    onChoosePrompt(next === null ? '' : example.prompt);
  };

  return (
    <View style={styles.panel}>
      <Text accessibilityRole="header" style={styles.title}>다운로드를 기다리며 미리보기</Text>
      <Text style={styles.intro}>관심 있는 주제를 골라 예시 대화를 살펴보세요.</Text>
      <View style={styles.topics}>
        {examples.map(({ label }, index) => (
          <Pressable
            key={label}
            accessibilityRole="button"
            accessibilityState={{ selected: index === active }}
            style={[styles.topic, index === active && styles.topicActive]}
            onPress={() => setActive(index)}
          >
            <Text style={[styles.topicLabel, index === active && styles.topicLabelActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.prompt}>
        <Text style={styles.promptText}>{example.prompt}</Text>
      </View>
      <View style={styles.answer}>
        <Text style={styles.answerLabel}>예시 답변</Text>
        <Text style={styles.answerText}>{example.answer}</Text>
      </View>
      <Pressable style={styles.choose} accessibilityRole="button" onPress={togglePrompt}>
        <Text style={styles.chooseLabel}>{chosen === active ? '선택 취소' : '첫 메시지로 준비하기'}</Text>
      </Pressable>
      {chosen !== null ? (
        <Text style={styles.intro} accessibilityLiveRegion="polite">
          {examples[chosen].label} 질문을 채팅 입력창에 담아둘게요.
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  panel: { gap: 12, padding: 18, borderRadius: 22, backgroundColor: colors.accentSoft },
  title: { color: colors.text, fontSize: 18, fontWeight: '800' },
  intro: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  topics: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  topic: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  topicActive: { borderColor: colors.accent, backgroundColor: colors.accent },
  topicLabel: { color: colors.accentText, fontSize: 13, fontWeight: '700' },
  topicLabelActive: { color: '#fff' },
  prompt: {
    alignSelf: 'flex-end',
    maxWidth: '94%',
    padding: 12,
    borderRadius: 16,
    borderBottomRightRadius: 5,
    backgroundColor: colors.userBubble,
  },
  promptText: { color: '#fff', fontSize: 14, lineHeight: 21 },
  answer: {
    alignSelf: 'flex-start',
    maxWidth: '94%',
    gap: 4,
    padding: 12,
    borderRadius: 16,
    borderBottomLeftRadius: 5,
    backgroundColor: colors.card,
  },
  answerLabel: { color: colors.accentText, fontSize: 12, fontWeight: '700' },
  answerText: { color: colors.text, fontSize: 14, lineHeight: 21 },
  choose: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  chooseLabel: { color: colors.accentText, fontSize: 14, fontWeight: '700', textAlign: 'center' },
});
